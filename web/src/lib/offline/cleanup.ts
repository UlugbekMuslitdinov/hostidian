import type { QueryClient } from "@tanstack/react-query";
import { APP_STORAGE_PREFIX, DEVICE_STORAGE_KEYS, PAGE_DB_PREFIX, pageDbName } from "./keys";
import { USER_DATA_CACHE_PREFIX } from "./sw-routes";
import type { KeyValueStore } from "./persister";
import type { UserScope } from "./user-scope";

/**
 * Removes everything the offline layer keeps on the device for the signed-in user. One function on purpose:
 * logout and "a different user signed in" must wipe exactly the same things.
 *
 *  - the persisted TanStack Query cache (incl. queued mutations) of every user;
 *  - every y-indexeddb database of a page (`page:<id>`);
 *  - the service worker's user-data caches (attachments / images);
 *  - app localStorage hints (tree state, recents, prefetch bookkeeping), except device-level preferences.
 *
 * Each step is independent and best effort: a failing step is reported, never thrown, so the others still run.
 */

export interface CleanupDeps {
  indexedDB?: Pick<IDBFactory, "deleteDatabase"> & Partial<Pick<IDBFactory, "databases">>;
  caches?: Pick<CacheStorage, "keys" | "delete">;
  localStorage?: Pick<Storage, "length" | "key" | "removeItem">;
}

export interface CleanupOptions {
  /** The persisted-cache store (IndexedDB key/value). */
  store: KeyValueStore;
  /** Stops pending cache writes (so nothing is re-created after the wipe). */
  persister?: { cancel(): void };
  /** Forgets whose data this device holds. */
  scope?: UserScope;
  /** Source of page ids for databases that `indexedDB.databases()` cannot list (older Firefox). */
  queryClient?: QueryClient;
  /** Also drop the queries and mutations held in memory by `queryClient` (user change; logout does it itself). */
  resetQueryClient?: boolean;
  /** Query keys (e.g. `["me"]`) to put back after the in-memory reset. */
  keepQueries?: ReadonlyArray<{ queryKey: readonly unknown[]; data: unknown }>;
  /** Page ids whose databases should be deleted even when `indexedDB.databases()` is unsupported. */
  knownPageIds?: Iterable<string>;
  deps?: CleanupDeps;
  /** How long to wait for a database that is still open somewhere before moving on (it is deleted once closed). */
  deleteGraceMs?: number;
}

export interface CleanupReport {
  pageDatabases: number;
  cachesDeleted: number;
  localStorageKeys: number;
  errors: string[];
}

export async function clearOfflineData(options: CleanupOptions): Promise<CleanupReport> {
  const deps = resolveDeps(options.deps);
  const report: CleanupReport = { pageDatabases: 0, cachesDeleted: 0, localStorageKeys: 0, errors: [] };
  const attempt = async (label: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (error) {
      report.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Order matters: stop writers first, then reset memory, then wipe storage.
  options.persister?.cancel();
  options.scope?.clear();

  const knownIds = [...(options.knownPageIds ?? []), ...(options.queryClient ? collectKnownPageIds(options.queryClient) : [])];
  if (options.queryClient && options.resetQueryClient) {
    const qc = options.queryClient;
    qc.getQueryCache().clear();
    qc.getMutationCache().clear();
    for (const { queryKey, data } of options.keepQueries ?? []) qc.setQueryData(queryKey, data);
  }

  await Promise.all([
    attempt("query cache", () => options.store.clear()),
    attempt("page documents", async () => {
      report.pageDatabases = await deletePageDatabases(deps.indexedDB, knownIds, options.deleteGraceMs ?? 2_000);
    }),
    attempt("service worker caches", async () => {
      report.cachesDeleted = await deleteUserCaches(deps.caches);
    }),
    attempt("local storage", () => {
      report.localStorageKeys = clearLocalStorageHints(deps.localStorage);
    }),
  ]);
  return report;
}

function resolveDeps(deps: CleanupDeps = {}): CleanupDeps {
  return {
    indexedDB: deps.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB),
    caches: deps.caches ?? (typeof caches === "undefined" ? undefined : caches),
    localStorage: deps.localStorage ?? safeLocalStorage(),
  };
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Page ids that appear in the in-memory query cache (tree lists and page details). */
export function collectKnownPageIds(queryClient: QueryClient): string[] {
  const ids = new Set<string>();
  for (const query of queryClient.getQueryCache().getAll()) {
    const key = query.queryKey;
    if (key[0] === "page" && typeof key[1] === "string") ids.add(key[1]);
    if (key[0] === "workspace" && key[2] === "pages" && Array.isArray(query.state.data)) {
      for (const page of query.state.data as Array<{ id?: unknown }>) if (typeof page.id === "string") ids.add(page.id);
    }
  }
  return [...ids];
}

async function deletePageDatabases(
  idb: CleanupDeps["indexedDB"],
  knownPageIds: readonly string[],
  graceMs: number,
): Promise<number> {
  if (!idb) return 0;
  const names = new Set<string>(knownPageIds.map(pageDbName));
  if (typeof idb.databases === "function") {
    for (const db of await idb.databases()) if (db.name?.startsWith(PAGE_DB_PREFIX)) names.add(db.name);
  }
  await Promise.all([...names].map((name) => deleteDatabase(idb, name, graceMs)));
  return names.size;
}

function deleteDatabase(idb: Pick<IDBFactory, "deleteDatabase">, name: string, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // An open editor still holds the database: the delete completes as soon as it closes, don't wait for it.
    request.onblocked = () => setTimeout(resolve, graceMs);
  });
}

async function deleteUserCaches(storage: CleanupDeps["caches"]): Promise<number> {
  if (!storage) return 0;
  const names = (await storage.keys()).filter((name) => name.startsWith(USER_DATA_CACHE_PREFIX));
  await Promise.all(names.map((name) => storage.delete(name)));
  return names.length;
}

function clearLocalStorageHints(storage: CleanupDeps["localStorage"]): number {
  if (!storage) return 0;
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(APP_STORAGE_PREFIX) && !DEVICE_STORAGE_KEYS.has(key)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
  return doomed.length;
}
