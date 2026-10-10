import { clear as idbClear, createStore as createIdbStore, del as idbDel, get as idbGet, set as idbSet } from "idb-keyval";
import type { DehydrateOptions, DehydratedState, Mutation, Query } from "@tanstack/react-query";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { createStore, type ExternalStore } from "./store";

/**
 * Offline persistence of the TanStack Query cache (page tree, page details, ...) and of the *queue of
 * unsent mutations*, in IndexedDB.
 *
 *  - One entry per user (`rq:v1:<userId>`), so another account on the same device never sees it.
 *  - `buster` (app version) and `maxAge` are enforced by TanStack when restoring.
 *  - Only successful, non-sensitive queries are written, plus every mutation that is still pending
 *    (paused offline *or* retrying), so queued edits survive a reload / crash.
 *  - Writes are throttled; a queued mutation shortens the delay because losing it is the costly case.
 *  - A full disk degrades to a smaller snapshot instead of failing the app.
 */

/** Bump when the shape of persisted data changes incompatibly (also part of the TanStack `buster`). */
export const PERSIST_SCHEMA_VERSION = 1;
export const PERSIST_KEY_PREFIX = `rq:v${PERSIST_SCHEMA_VERSION}:`;
/**
 * TanStack's `buster`: a snapshot written under a different value is discarded on restore. Deliberately tied to the
 * schema version, not to the build: an app update must not throw away mutations that are still queued.
 */
export const PERSIST_BUSTER = `schema-${PERSIST_SCHEMA_VERSION}`;
export const persistKey = (userId: string) => `${PERSIST_KEY_PREFIX}${userId}`;

/** Offline data older than this is discarded on restore (and queries are kept in memory that long). */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_THROTTLE_MS = 1_000;
export const MUTATION_THROTTLE_MS = 100;

// ------------------------------------------------------------------ key-value storage

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<void>;
}

export const OFFLINE_DB_NAME = "hostidian-offline";

/** idb-keyval backed store. The database is opened lazily so importing this module is safe during SSR. */
export function createIdbKeyValueStore(dbName = OFFLINE_DB_NAME, storeName = "kv"): KeyValueStore {
  let store: ReturnType<typeof createIdbStore> | undefined;
  const open = () => (store ??= createIdbStore(dbName, storeName));
  return {
    get: <T>(key: string) => idbGet<T>(key, open()),
    set: (key, value) => idbSet(key, value, open()),
    del: (key) => idbDel(key, open()),
    clear: () => idbClear(open()),
  };
}

// ------------------------------------------------------------------ what gets persisted

/** Roots of the query keys in lib/api/keys.ts that are worth keeping on the device. */
const PERSISTED_ROOTS: ReadonlySet<unknown> = new Set(["me", "instance", "workspace", "page"]);
/** `["workspace", id, <segment>]` segments that are ephemeral or sensitive. */
const SKIPPED_WORKSPACE_SEGMENTS: ReadonlySet<unknown> = new Set(["search", "invites"]);
/** `["page", id, <segment>]` segments that are only useful online (share links, grants). */
const SKIPPED_PAGE_SEGMENTS: ReadonlySet<unknown> = new Set(["permissions", "shares"]);

export function isPersistableQueryKey(key: readonly unknown[]): boolean {
  if (!PERSISTED_ROOTS.has(key[0])) return false;
  if (key[0] === "workspace" && SKIPPED_WORKSPACE_SEGMENTS.has(key[2])) return false;
  if (key[0] === "page" && SKIPPED_PAGE_SEGMENTS.has(key[2])) return false;
  return true;
}

/** What survives when storage is nearly full: the identity, the tree and the page headers. */
function isEssentialQueryKey(key: readonly unknown[]): boolean {
  if (key[0] === "me") return true;
  if (key[0] === "workspace") return ["pages", "favorites", "recent", "trash"].includes(String(key[2]));
  if (key[0] === "page") return key.length === 2;
  return false;
}

export function shouldPersistQuery(query: Query): boolean {
  return query.state.status === "success" && query.meta?.persist !== false && isPersistableQueryKey(query.queryKey);
}

/** A mutation can be replayed after a reload iff it is unfinished and its handlers are registered by key. */
export function shouldPersistMutation(mutation: Mutation): boolean {
  return (
    mutation.state.status === "pending" &&
    mutation.options.mutationKey !== undefined &&
    typeof mutation.options.mutationFn === "function"
  );
}

export const dehydrateOptions: DehydrateOptions = {
  shouldDehydrateQuery: shouldPersistQuery,
  shouldDehydrateMutation: shouldPersistMutation,
};

type PersistedMutation = DehydratedState["mutations"][number];
type PersistedQuery = DehydratedState["queries"][number];

/**
 * Normalizes a snapshot before it is written:
 *  - unfinished mutations are stored as paused, so `resumePausedMutations()` replays them after a reload even
 *    if they were mid-retry (or mid-flight) when the page went away;
 *  - rollback snapshots (`context`, a full copy of the tree per queued mutation) are dropped. The mutations'
 *    `settle()` refetches the tree after a failed replay, which restores the truth without them;
 *  - error objects (not reliably structured-cloneable) are dropped.
 */
export function sanitizeForPersist(client: PersistedClient): PersistedClient {
  const { mutations, queries } = client.clientState;
  return {
    ...client,
    clientState: {
      mutations: mutations.map(
        (m): PersistedMutation => ({
          ...m,
          state: { ...m.state, isPaused: true, context: undefined, error: null, failureCount: 0, failureReason: null },
        }),
      ),
      queries: queries.map(
        (q): PersistedQuery => ({
          ...q,
          state: { ...q.state, fetchStatus: "idle", fetchFailureCount: 0, fetchFailureReason: null, error: null },
        }),
      ),
    },
  };
}

/** A smaller snapshot for when the full one does not fit. `level` 2 keeps only the queued mutations and the identity. */
export function shrinkForQuota(client: PersistedClient, level: 1 | 2): PersistedClient {
  const keep = level === 1 ? isEssentialQueryKey : (key: readonly unknown[]) => key[0] === "me";
  return { ...client, clientState: { ...client.clientState, queries: client.clientState.queries.filter((q) => keep(q.queryKey)) } };
}

export function isPersistedClient(value: unknown): value is PersistedClient {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PersistedClient>;
  return (
    typeof v.timestamp === "number" &&
    typeof v.buster === "string" &&
    typeof v.clientState === "object" &&
    v.clientState !== null &&
    Array.isArray(v.clientState.queries) &&
    Array.isArray(v.clientState.mutations)
  );
}

export function isQuotaError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    code === 22 ||
    (typeof message === "string" && /quota/i.test(message))
  );
}

// ------------------------------------------------------------------ status

export type PersistState = "ok" | "quota" | "unavailable";
export interface PersistStatus {
  state: PersistState;
}

/** Whether the offline cache is actually being written (shown in the connectivity indicator). */
export const persistStatus: ExternalStore<PersistStatus> = createStore<PersistStatus>({ state: "ok" });

// ------------------------------------------------------------------ the persister

export interface OfflinePersisterOptions {
  store: KeyValueStore;
  /** Namespace of the cache to read/write; `null` (nobody signed in) disables persistence. */
  getUserId: () => string | null;
  throttleMs?: number;
  mutationThrottleMs?: number;
  onStatus?: (state: PersistState) => void;
}

export interface OfflinePersister extends Persister {
  /** Write the latest snapshot now (used when the page is being hidden). */
  flush(): Promise<void>;
  /** Drop any snapshot that has not been written yet (used by logout cleanup). */
  cancel(): void;
}

export function createOfflinePersister(options: OfflinePersisterOptions): OfflinePersister {
  const { store, getUserId } = options;
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const mutationThrottleMs = options.mutationThrottleMs ?? MUTATION_THROTTLE_MS;
  const report = options.onStatus ?? ((state: PersistState) => persistStatus.set({ state }));

  let pending: { client: PersistedClient; userId: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDelay = Infinity;
  let chain: Promise<void> = Promise.resolve();

  const writeSnapshot = async (userId: string, client: PersistedClient): Promise<void> => {
    const full = sanitizeForPersist(client);
    const candidates = [full, shrinkForQuota(full, 1), shrinkForQuota(full, 2)];
    for (const [index, candidate] of candidates.entries()) {
      try {
        await put(store, persistKey(userId), candidate);
        report(index === 0 ? "ok" : "quota");
        return;
      } catch (error) {
        if (!isQuotaError(error)) {
          report("unavailable");
          return;
        }
      }
    }
    report("quota");
  };

  const run = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    timerDelay = Infinity;
    const job = pending;
    pending = null;
    if (!job) return chain;
    chain = chain.then(async () => {
      // The account may have changed while the snapshot was waiting: never write it into another user's slot.
      if (getUserId() !== job.userId) return;
      await writeSnapshot(job.userId, job.client);
    });
    return chain;
  };

  return {
    persistClient(client) {
      const userId = getUserId();
      if (!userId) return;
      pending = { client, userId };
      const delay = client.clientState.mutations.length > 0 ? mutationThrottleMs : throttleMs;
      if (timer !== null && delay >= timerDelay) return;
      if (timer !== null) clearTimeout(timer);
      timerDelay = delay;
      timer = setTimeout(() => void run(), delay);
    },

    async restoreClient() {
      const userId = getUserId();
      if (!userId) return undefined;
      try {
        const value = await store.get<unknown>(persistKey(userId));
        if (isPersistedClient(value)) return value;
        if (value !== undefined) await store.del(persistKey(userId)); // unreadable leftovers
      } catch {
        // IndexedDB unavailable or corrupt: start from an empty cache.
      }
      return undefined;
    },

    async removeClient() {
      pending = null;
      const userId = getUserId();
      if (!userId) return;
      try {
        await store.del(persistKey(userId));
      } catch {
        // nothing to remove
      }
    },

    flush: run,

    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      timerDelay = Infinity;
      pending = null;
    },
  };
}

/** `set`, retrying once through a JSON round trip if the snapshot contains something structured clone rejects. */
async function put(store: KeyValueStore, key: string, value: PersistedClient): Promise<void> {
  try {
    await store.set(key, value);
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "DataCloneError") {
      await store.set(key, JSON.parse(JSON.stringify(value)));
      return;
    }
    throw error;
  }
}
