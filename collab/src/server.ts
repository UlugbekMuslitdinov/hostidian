import { Server } from "@hocuspocus/server";
import type { Pool } from "pg";
import { applyMarkdown } from "./apply-markdown";
import { createAuthExtension, type ConnectionContext } from "./auth";
import type { Config } from "./config";
import { ContentSync } from "./content-sync";
import { importMarkdown } from "./import-markdown";
import { createInternalServer } from "./internal-api";
import { createLogger, errorFields, type Logger } from "./logger";
import {
  DocumentPersister,
  GonePages,
  createPersistenceExtension,
  createPool,
  createPostgresStore,
  type PageDocumentStore,
  type RetryOptions,
} from "./persistence";
import { ContentPusher } from "./push";
import { documentNameFor } from "./auth";

/** Document debounce per docs/conventions.md §6 (2 s, at most 10 s). */
const STORE_DEBOUNCE_MS = 2_000;
const STORE_MAX_DEBOUNCE_MS = 10_000;
const MAX_WEBSOCKET_PAYLOAD = 32 * 1024 * 1024;
const SHUTDOWN_STORE_TIMEOUT_MS = 20_000;
const SHUTDOWN_PUSH_TIMEOUT_MS = 10_000;

export interface CollabServerOverrides {
  logger?: Logger;
  /** Replaces the Postgres store (tests). */
  store?: PageDocumentStore;
  fetch?: typeof fetch;
  pushRetry?: Partial<RetryOptions>;
  persistRetry?: Partial<RetryOptions>;
  /** Overrides the store debounce (tests). */
  debounceMs?: number;
  maxDebounceMs?: number;
  storeRetryDelayMs?: number;
}

export interface CollabServer {
  /** Bound ports (differ from the config when it asks for port 0). Valid after `start()`. */
  readonly port: number;
  readonly internalPort: number;
  readonly hocuspocus: Server<ConnectionContext>["hocuspocus"];
  start(): Promise<void>;
  /** Graceful: refuse new work, close sockets, flush pending stores, push their content, close the pool. */
  stop(): Promise<void>;
}

export function createCollabServer(config: Config, overrides: CollabServerOverrides = {}): CollabServer {
  const logger = overrides.logger ?? createLogger(config.logLevel);

  let pool: Pool | undefined;
  let store = overrides.store;
  if (!store) {
    pool = createPool(config.databaseUrl, logger);
    store = createPostgresStore(pool);
  }

  const pusher = new ContentPusher({
    apiInternalUrl: config.apiInternalUrl,
    internalToken: config.internalToken,
    logger,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.pushRetry ? { retry: overrides.pushRetry } : {}),
  });

  const gone = new GonePages();
  // Late-bound: the callbacks fire after the server below exists.
  const pageGone = (pageId: string) => {
    gone.mark(pageId);
    collab.hocuspocus.closeConnections(documentNameFor(pageId));
  };
  const sync = new ContentSync({ pusher, logger, onPageGone: pageGone });
  const persister = new DocumentPersister({
    store,
    sync,
    gone,
    logger,
    onPageGone: pageGone,
    ...(overrides.persistRetry ? { retry: overrides.persistRetry } : {}),
  });

  const collab = new Server<ConnectionContext>({
    name: "hostidian-collab",
    port: config.port,
    quiet: true,
    stopOnSignals: false,
    debounce: overrides.debounceMs ?? STORE_DEBOUNCE_MS,
    maxDebounce: overrides.maxDebounceMs ?? STORE_MAX_DEBOUNCE_MS,
    websocketOptions: { maxPayload: MAX_WEBSOCKET_PAYLOAD },
    extensions: [
      createAuthExtension(
        { secret: new TextEncoder().encode(config.jwtSecret), allowedOrigins: config.allowedOrigins },
        logger.child({ component: "auth" }),
      ),
      createPersistenceExtension({
        store,
        persister,
        sync,
        logger: logger.child({ component: "persistence" }),
        ...(overrides.storeRetryDelayMs !== undefined ? { storeRetryDelayMs: overrides.storeRetryDelayMs } : {}),
      }),
      {
        extensionName: "hostidian-http",
        // Plain HTTP on the WebSocket port is not an API: answer 404 instead of Hocuspocus' welcome banner.
        async onRequest({ response }) {
          response.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
          return Promise.reject();
        },
      },
    ],
  });

  const internal = createInternalServer({
    token: config.internalToken,
    registry: collab.hocuspocus,
    importMarkdown: (request) => importMarkdown({ hocuspocus: collab.hocuspocus, persister, sync }, request),
    applyMarkdown: (request) => applyMarkdown({ hocuspocus: collab.hocuspocus, persister, sync }, request),
    logger: logger.child({ component: "internal-api" }),
  });

  let stopping: Promise<void> | undefined;

  return {
    get port() {
      return collab.address.port;
    },
    get internalPort() {
      const address = internal.address();
      return typeof address === "object" && address ? address.port : config.internalPort;
    },
    hocuspocus: collab.hocuspocus,

    async start() {
      // Not fatal (compose may start us before Postgres is ready), but worth a clear line in the log.
      if (pool) {
        await pool.query("SELECT 1").then(
          () => logger.info("database reachable"),
          (error: unknown) => logger.warn("database not reachable yet", errorFields(error)),
        );
      }
      await collab.listen();
      await new Promise<void>((resolve, reject) => {
        internal.once("error", reject);
        internal.listen(config.internalPort, () => {
          internal.off("error", reject);
          resolve();
        });
      });
      logger.info("collab listening", { port: this.port, internalPort: this.internalPort });
    },

    stop() {
      stopping ??= (async () => {
        logger.info("collab shutting down");
        internal.close();
        internal.closeIdleConnections();
        // Closes sockets and flushes pending (debounced) stores; resolves once every document is stored and unloaded.
        await Promise.race([
          collab.destroy(),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              logger.error("timed out waiting for documents to be stored");
              resolve();
            }, SHUTDOWN_STORE_TIMEOUT_MS).unref(),
          ),
        ]).catch((error: unknown) => logger.error("error while stopping hocuspocus", errorFields(error)));
        // Last pushes get one attempt each; nothing is retried any more.
        pusher.close();
        await sync.drain(SHUTDOWN_PUSH_TIMEOUT_MS);
        internal.closeAllConnections();
        await pool?.end().catch((error: unknown) => logger.error("error while closing the pool", errorFields(error)));
        logger.info("collab stopped");
      })();
      return stopping;
    },
  };
}
