import pg from "pg";
import * as Y from "yjs";
import type {
  Extension,
  afterUnloadDocumentPayload,
  onChangePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from "@hocuspocus/server";
import { pageIdFromDocumentName, type ConnectionContext } from "./auth";
import type { ContentSync } from "./content-sync";
import { errorFields, type Logger } from "./logger";

/**
 * Binary Yjs state per page in `page_documents`. This service is the only writer of the table (the API only copies or
 * deletes rows for duplicate/purge).
 */
export interface PageDocumentStore {
  /** The stored Yjs update, or `null` when the page has no document yet. */
  load(pageId: string): Promise<Uint8Array | null>;
  /** Upserts the state. `"page_gone"` = the page row no longer exists (foreign key violation). */
  save(pageId: string, state: Uint8Array): Promise<"stored" | "page_gone">;
}

const FOREIGN_KEY_VIOLATION = "23503";

export function createPool(databaseUrl: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // A hung statement must not hold up the debounced store loop forever.
    statement_timeout: 30_000,
  });
  // Without a listener an error on an idle client would crash the process.
  pool.on("error", (error) => logger.error("postgres pool error", errorFields(error)));
  return pool;
}

export interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function createPostgresStore(pool: QueryablePool): PageDocumentStore {
  return {
    async load(pageId) {
      const result = await pool.query("SELECT ydoc FROM page_documents WHERE page_id = $1", [pageId]);
      const row = result.rows[0];
      if (!row) return null;
      const ydoc = row.ydoc;
      if (!(ydoc instanceof Uint8Array)) throw new Error(`page_documents.ydoc for ${pageId} is not binary`);
      // pg hands out Buffers; callers (and tests) want a plain Uint8Array over the same bytes.
      return new Uint8Array(ydoc.buffer, ydoc.byteOffset, ydoc.byteLength);
    },

    async save(pageId, state) {
      try {
        await pool.query(
          `INSERT INTO page_documents (page_id, ydoc, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (page_id) DO UPDATE SET ydoc = EXCLUDED.ydoc, updated_at = now()`,
          [pageId, Buffer.from(state.buffer, state.byteOffset, state.byteLength)],
        );
        return "stored";
      } catch (error) {
        if ((error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION) return "page_gone";
        throw error;
      }
    },
  };
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Consulted after each failure; `false` rethrows immediately (non-retryable error, shutdown, superseded work). */
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter. Rethrows the last error. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.attempts || options.shouldRetry?.(error) === false) throw error;
      const exp = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(exp * (0.8 + Math.random() * 0.4));
      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}

// =====================================================================================================================
// Hocuspocus integration
// =====================================================================================================================

/** Pages the API (or the database) says no longer exist. Remembered briefly so stragglers do not keep failing. */
export class GonePages {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  mark(pageId: string): void {
    const now = this.now();
    // Entries are only otherwise dropped when asked about; sweep so the map cannot grow without bound.
    if (this.until.size >= 1_000) {
      for (const [id, expiry] of this.until) if (expiry <= now) this.until.delete(id);
    }
    this.until.set(pageId, now + this.ttlMs);
  }

  has(pageId: string): boolean {
    const expiry = this.until.get(pageId);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.until.delete(pageId);
      return false;
    }
    return true;
  }
}

export interface PersisterOptions {
  store: PageDocumentStore;
  sync: ContentSync;
  gone: GonePages;
  logger: Logger;
  /** Called once when a page turns out not to exist any more (FK violation here, 404 from the API in `sync`). */
  onPageGone: (pageId: string) => void;
  retry?: Partial<RetryOptions>;
}

/** Writes a Yjs document to `page_documents` and hands a snapshot to `ContentSync`. */
export class DocumentPersister {
  constructor(private readonly options: PersisterOptions) {}

  /**
   * Stores `document` (retrying transient database errors) and queues extraction+push.
   * With `wait`, resolves only after the content push finished and throws if it failed (used by markdown import);
   * otherwise the push runs in the background. Throws if the database write keeps failing.
   */
  async persist(pageId: string, document: Y.Doc, { wait = false }: { wait?: boolean } = {}): Promise<"stored" | "page_gone"> {
    const { store, sync, gone, logger } = this.options;
    if (gone.has(pageId)) return "page_gone";

    const state = Y.encodeStateAsUpdate(document);
    const editorIds = sync.takeEditors(pageId);
    let outcome: "stored" | "page_gone";
    try {
      outcome = await withRetry(
        () => store.save(pageId, state),
        { attempts: 4, baseDelayMs: 250, maxDelayMs: 2_000, ...this.options.retry },
        (error, attempt, delayMs) =>
          logger.warn("storing document failed, retrying", { pageId, attempt, delayMs, ...errorFields(error) }),
      );
    } catch (error) {
      sync.restoreEditors(pageId, editorIds);
      throw error;
    }

    if (outcome === "page_gone") {
      logger.warn("page no longer exists; dropping its document", { pageId });
      gone.mark(pageId);
      this.options.onPageGone(pageId);
      return "page_gone";
    }

    const pushed = sync.schedule(pageId, state, editorIds, { strict: wait });
    if (!wait) {
      pushed.catch(() => {}); // already logged inside ContentSync
      return "stored";
    }
    await pushed;
    return gone.has(pageId) ? "page_gone" : "stored";
  }
}

export interface PersistenceExtensionOptions {
  store: PageDocumentStore;
  persister: DocumentPersister;
  sync: ContentSync;
  logger: Logger;
  /** Delay before a failed store is attempted again without waiting for the next edit. */
  storeRetryDelayMs?: number;
}

/** `onLoadDocument` / `onStoreDocument` for Hocuspocus, plus bookkeeping of who edited. */
export function createPersistenceExtension(options: PersistenceExtensionOptions): Extension<ConnectionContext> {
  const { store, persister, sync, logger } = options;
  const retryTimers = new Map<string, NodeJS.Timeout>();

  return {
    extensionName: "hostidian-persistence",

    async onLoadDocument({ document, documentName }: onLoadDocumentPayload<ConnectionContext>) {
      const pageId = pageIdFromDocumentName(documentName);
      if (!pageId) throw new Error(`unexpected document name ${JSON.stringify(documentName)}`);
      const state = await withRetry(() => store.load(pageId), { attempts: 3, baseDelayMs: 200, maxDelayMs: 1_000 });
      // A corrupt row makes applyUpdate throw: the load fails and the stored bytes are left untouched.
      if (state) Y.applyUpdate(document, state);
      logger.debug("document loaded", { pageId, bytes: state?.byteLength ?? 0 });
    },

    async onChange({ documentName, context }: onChangePayload<ConnectionContext>) {
      const pageId = pageIdFromDocumentName(documentName);
      const userId = context?.user?.id;
      if (pageId && userId) sync.noteEditor(pageId, userId);
    },

    async onStoreDocument(payload: onStoreDocumentPayload<ConnectionContext>) {
      const { document, documentName, instance } = payload;
      const pageId = pageIdFromDocumentName(documentName);
      if (!pageId) return;
      try {
        await persister.persist(pageId, document);
      } catch (error) {
        logger.error("storing document failed; will retry", { pageId, ...errorFields(error) });
        // Hocuspocus keeps the document in memory but only stores again on the next edit; do not wait for one.
        if (!retryTimers.has(documentName)) {
          const timer = setTimeout(() => {
            retryTimers.delete(documentName);
            if (instance.documents.get(documentName) === document) {
              void instance.storeDocumentHooks(document, payload, true);
            }
          }, options.storeRetryDelayMs ?? 5_000);
          timer.unref();
          retryTimers.set(documentName, timer);
        }
        throw error;
      }
    },

    async afterUnloadDocument({ documentName }: afterUnloadDocumentPayload) {
      const pageId = pageIdFromDocumentName(documentName);
      if (pageId) sync.forget(pageId);
      const timer = retryTimers.get(documentName);
      if (timer) clearTimeout(timer);
      retryTimers.delete(documentName);
    },
  };
}
