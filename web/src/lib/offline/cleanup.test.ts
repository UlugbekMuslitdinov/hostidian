import "fake-indexeddb/auto";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../storage";
import { clearOfflineData, collectKnownPageIds } from "./cleanup";
import { OFFLINE_KEYS, PAGE_DB_PREFIX, pageDbName } from "./keys";
import { persistKey } from "./persister";
import { CACHE_NAMES } from "./sw-routes";
import { createMemoryStore } from "./test-helpers";

/** Creates the database; resolves with the open connection (callers close it unless they want it held open). */
function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("updates", { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function createDb(name: string) {
  (await openDb(name)).close();
}

const listDbs = async () => (await indexedDB.databases()).map((d) => d.name).filter(Boolean) as string[];

function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
  };
}

function fakeCaches(names: string[]) {
  const live = new Set(names);
  return {
    live,
    keys: async () => [...live],
    delete: async (name: string) => live.delete(name),
  };
}

describe("clearOfflineData", () => {
  beforeEach(async () => {
    for (const name of await listDbs()) indexedDB.deleteDatabase(name);
  });

  it("wipes the persisted cache, every page database, the user caches and the app's localStorage hints", async () => {
    await createDb(pageDbName("aaa"));
    await createDb(pageDbName("bbb"));
    await createDb("unrelated-db");
    const store = createMemoryStore({ [persistKey("u1")]: {}, [persistKey("u2")]: {} });
    const caches = fakeCaches([CACHE_NAMES.files, CACHE_NAMES.pages, CACHE_NAMES.rsc, "workbox-other"]);
    const ls = fakeStorage({
      [OFFLINE_KEYS.lastUser]: "u1",
      [OFFLINE_KEYS.prefetch("u1")]: "{}",
      [STORAGE_KEYS.lastWorkspace]: "acme",
      [STORAGE_KEYS.treeExpanded("u1", "w")]: "[]",
      [STORAGE_KEYS.sidebarOpen]: "0",
      [OFFLINE_KEYS.installDismissedAt]: "123",
      "somebody-elses-key": "x",
    });
    const persister = { cancel: vi.fn() };
    const scope = { get: vi.fn(), set: vi.fn(), clear: vi.fn(), refresh: vi.fn() };

    const report = await clearOfflineData({
      store,
      persister,
      scope,
      deps: { indexedDB, caches, localStorage: ls },
    });

    expect(report.errors).toEqual([]);
    expect(persister.cancel).toHaveBeenCalled();
    expect(scope.clear).toHaveBeenCalled();
    expect(store.data.size).toBe(0); // every user's snapshot, not just the current one
    expect(await listDbs()).toEqual(["unrelated-db"]);
    expect(report.pageDatabases).toBe(2);
    expect([...caches.live].sort()).toEqual([CACHE_NAMES.pages, CACHE_NAMES.rsc, "workbox-other"].sort());
    expect(report.cachesDeleted).toBe(1); // only the per-user attachment cache
    // Device-level preferences survive; user-level hints and foreign keys are handled correctly.
    expect([...ls.map.keys()].sort()).toEqual(["somebody-elses-key", STORAGE_KEYS.sidebarOpen, OFFLINE_KEYS.installDismissedAt].sort());
  });

  it("deletes page databases it learned about from the query cache when indexedDB.databases() is unavailable", async () => {
    await createDb(pageDbName("known-id"));
    const qc = new QueryClient();
    qc.setQueryData(["workspace", "w", "pages"], [{ id: "known-id" }]);
    const idbWithoutList = { deleteDatabase: indexedDB.deleteDatabase.bind(indexedDB) };
    const report = await clearOfflineData({
      store: createMemoryStore(),
      queryClient: qc,
      deps: { indexedDB: idbWithoutList, caches: fakeCaches([]), localStorage: fakeStorage({}) },
    });
    expect(report.pageDatabases).toBe(1);
    expect(await listDbs()).toEqual([]);
  });

  it("can reset the in-memory query client and keep the identity", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["workspace", "w", "pages"], [{ id: "p" }]);
    qc.setQueryData(["me"], { user: { id: "u2" } });
    await clearOfflineData({
      store: createMemoryStore(),
      queryClient: qc,
      resetQueryClient: true,
      keepQueries: [{ queryKey: ["me"], data: { user: { id: "u2" } } }],
      deps: { indexedDB, caches: fakeCaches([]), localStorage: fakeStorage({}) },
    });
    expect(qc.getQueryData(["workspace", "w", "pages"])).toBeUndefined();
    expect(qc.getQueryData(["me"])).toEqual({ user: { id: "u2" } });
  });

  it("keeps going and reports when one step fails", async () => {
    const store = createMemoryStore();
    store.clear = async () => {
      throw new Error("disk on fire");
    };
    const caches = fakeCaches([CACHE_NAMES.files]);
    const report = await clearOfflineData({ store, deps: { indexedDB, caches, localStorage: fakeStorage({}) } });
    expect(report.errors).toEqual(["query cache: disk on fire"]);
    expect(caches.live.size).toBe(0); // the other steps still ran
  });

  it("does not hang on a database that an open editor still holds", async () => {
    const name = pageDbName("open");
    const db = await openDb(name);
    // Never closes: deleteDatabase will be "blocked".
    const started = Date.now();
    const report = await clearOfflineData({
      store: createMemoryStore(),
      deleteGraceMs: 30,
      deps: { indexedDB, caches: fakeCaches([]), localStorage: fakeStorage({}) },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(report.pageDatabases).toBe(1);
    db.close(); // the pending delete now completes
    await vi.waitFor(async () => expect(await listDbs()).not.toContain(name));
  });
});

describe("collectKnownPageIds", () => {
  it("reads ids from page details and the tree lists", () => {
    const qc = new QueryClient();
    qc.setQueryData(["page", "one"], {});
    qc.setQueryData(["workspace", "w", "pages"], [{ id: "two" }, { id: "three" }]);
    qc.setQueryData(["workspace", "w", "favorites"], [{ id: "ignored" }]);
    expect(collectKnownPageIds(qc).sort()).toEqual(["one", "three", "two"]);
  });

  it("uses the contract prefix", () => {
    expect(PAGE_DB_PREFIX).toBe("page:");
    expect(pageDbName("x")).toBe("page:x");
  });
});
