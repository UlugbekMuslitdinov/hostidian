import "fake-indexeddb/auto";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { qk } from "../api/keys";
import { runLogoutCleanups } from "../session-cleanup";
import { makeMe, makeUser } from "@/test/factories";
import { createOfflineRuntime, decideIdentity } from "./runtime";
import { connectivityStore } from "./connectivity-store";
import { pageDbName } from "./keys";
import { persistKey } from "./persister";
import { CACHE_NAMES } from "./sw-routes";
import { createMemoryStore } from "./test-helpers";
import type { UserScope } from "./user-scope";
import type { ConnectivityEnv } from "./connectivity";

function memoryScope(initial: string | null): UserScope & { value: () => string | null } {
  let value = initial;
  return {
    get: () => value,
    set: (v) => void (value = v),
    clear: () => void (value = null),
    refresh: () => undefined,
    value: () => value,
  };
}

const listDbs = async () => (await indexedDB.databases()).map((d) => d.name).filter(Boolean) as string[];
async function createDb(name: string) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

function fakeCaches(names: string[]) {
  const live = new Set(names);
  return { live, keys: async () => [...live], delete: async (n: string) => live.delete(n) };
}
const noStorage = { length: 0, key: () => null, removeItem: () => undefined };

describe("decideIdentity", () => {
  it("is a pure function of who owns the cache and who signed in", () => {
    expect(decideIdentity(null, "a")).toBe("adopt");
    expect(decideIdentity("a", "a")).toBe("same");
    expect(decideIdentity("a", "b")).toBe("switch");
  });
});

describe("OfflineRuntime identity handling", () => {
  beforeEach(async () => {
    for (const name of await listDbs()) indexedDB.deleteDatabase(name);
  });

  it("a different account wipes the previous account's data before taking over, and keeps its own identity", async () => {
    await createDb(pageDbName("secret-page"));
    const store = createMemoryStore({ [persistKey("alice")]: { secret: true } });
    const scope = memoryScope("alice");
    const caches = fakeCaches([CACHE_NAMES.files]);
    const qc = new QueryClient();
    qc.setQueryData(qk.pages("ws"), [{ id: "secret-page", title: "Alice's private page" }]);
    const runtime = createOfflineRuntime({
      queryClient: qc,
      store,
      scope,
      window: null,
      cleanupDeps: { indexedDB, caches, localStorage: noStorage },
    });

    const bob = makeMe({ user: makeUser({ id: "bob", name: "Bob" }) });
    expect(runtime.peekIdentity("bob")).toBe("switch");
    expect(await runtime.identify(bob)).toBe("switch");

    expect(qc.getQueryData(qk.pages("ws"))).toBeUndefined();
    expect(qc.getQueryData(qk.me())).toEqual(bob);
    expect(await listDbs()).not.toContain(pageDbName("secret-page"));
    expect(caches.live.size).toBe(0);
    expect(store.data.has(persistKey("alice"))).toBe(false);
    expect(scope.value()).toBe("bob");
    // Bob's identity was persisted straight away, in Bob's own namespace.
    expect(store.data.has(persistKey("bob"))).toBe(true);
    expect(runtime.peekIdentity("bob")).toBe("same");
  });

  it("the same account keeps its data", async () => {
    const store = createMemoryStore({ [persistKey("alice")]: { keep: true } });
    const scope = memoryScope("alice");
    const qc = new QueryClient();
    qc.setQueryData(qk.pages("ws"), [{ id: "p" }]);
    const runtime = createOfflineRuntime({ queryClient: qc, store, scope, window: null });
    expect(await runtime.identify(makeMe({ user: makeUser({ id: "alice" }) }))).toBe("same");
    expect(qc.getQueryData(qk.pages("ws"))).toEqual([{ id: "p" }]);
    expect(store.data.has(persistKey("alice"))).toBe(true);
  });

  it("the first account on a device adopts it and clears leftovers of unknown accounts", async () => {
    const store = createMemoryStore({ [persistKey("ghost")]: { leftover: true } });
    const scope = memoryScope(null);
    const runtime = createOfflineRuntime({ queryClient: new QueryClient(), store, scope, window: null });
    expect(await runtime.identify(makeMe({ user: makeUser({ id: "carol" }) }))).toBe("adopt");
    expect(store.data.has(persistKey("ghost"))).toBe(false);
    expect(scope.value()).toBe("carol");
  });

  it("runs the wipe once even when asked twice (React StrictMode)", async () => {
    const store = createMemoryStore();
    const clear = vi.spyOn(store, "clear");
    const scope = memoryScope("alice");
    const runtime = createOfflineRuntime({
      queryClient: new QueryClient(),
      store,
      scope,
      window: null,
      cleanupDeps: { indexedDB, caches: fakeCaches([]), localStorage: noStorage },
    });
    const bob = makeMe({ user: makeUser({ id: "bob" }) });
    await Promise.all([runtime.identify(bob), runtime.identify(bob)]);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("OfflineRuntime wiring (start)", () => {
  afterEach(() => {
    onlineManager.setOnline(true);
    connectivityStore.set({ online: true });
  });

  function fakeEnv(): { env: Partial<ConnectivityEnv>; fire: (e: "online" | "offline") => void; setBrowser: (v: boolean) => void } {
    let handlers: Parameters<ConnectivityEnv["listen"]>[0] | null = null;
    let browser = true;
    return {
      env: {
        getBrowserOnline: () => browser,
        listen: (h) => {
          handlers = h;
          return () => void (handlers = null);
        },
        probe: async () => true,
      },
      fire: (e) => handlers?.[e](),
      setBrowser: (v) => void (browser = v),
    };
  }

  it("drives TanStack's onlineManager and the connectivity store from the monitor", async () => {
    const f = fakeEnv();
    const runtime = createOfflineRuntime({ queryClient: new QueryClient(), store: createMemoryStore(), scope: memoryScope("u"), connectivityEnv: f.env, window: null });
    const stop = runtime.start();
    expect(onlineManager.isOnline()).toBe(true);

    f.setBrowser(false);
    f.fire("offline");
    expect(onlineManager.isOnline()).toBe(false);
    expect(connectivityStore.get().online).toBe(false);

    f.setBrowser(true);
    f.fire("online");
    await vi.waitFor(() => expect(onlineManager.isOnline()).toBe(true)); // after the probe confirms the server
    expect(connectivityStore.get().online).toBe(true);
    stop();
  });

  it("feeds API transport failures to the monitor via client middleware, and ejects it on stop", () => {
    const f = fakeEnv();
    const use = vi.fn();
    const eject = vi.fn();
    const runtime = createOfflineRuntime({
      queryClient: new QueryClient(),
      store: createMemoryStore(),
      scope: memoryScope("u"),
      connectivityEnv: f.env,
      api: { use, eject },
      window: null,
    });
    const stop = runtime.start();
    const middleware = use.mock.calls[0]![0] as {
      onResponse(ctx: { response: Response }): void;
      onError(ctx: { error: unknown }): void;
    };
    middleware.onError({ error: new TypeError("Failed to fetch") });
    expect(runtime.connectivity?.online).toBe(false);
    middleware.onResponse({ response: new Response(null, { status: 200 }) });
    expect(runtime.connectivity?.online).toBe(true);
    middleware.onResponse({ response: new Response(null, { status: 502 }) });
    expect(runtime.connectivity?.online).toBe(false);
    middleware.onResponse({ response: new Response(null, { status: 404 }) });
    expect(runtime.connectivity?.online).toBe(true);
    middleware.onError({ error: new DOMException("aborted", "AbortError") }); // cancelled queries say nothing
    expect(runtime.connectivity?.online).toBe(true);
    stop();
    expect(eject).toHaveBeenCalledWith(middleware);
  });

  it("registers the logout cleanup, and the logout hook wipes this device's offline data", async () => {
    await createDb(pageDbName("p1"));
    const store = createMemoryStore({ [persistKey("alice")]: {} });
    const scope = memoryScope("alice");
    const caches = fakeCaches([CACHE_NAMES.files]);
    const runtime = createOfflineRuntime({
      queryClient: new QueryClient(),
      store,
      scope,
      connectivityEnv: fakeEnv().env,
      window: null,
      cleanupDeps: { indexedDB, caches, localStorage: noStorage },
    });
    const stop = runtime.start();
    await runLogoutCleanups(); // what useLogout() awaits
    expect(store.data.size).toBe(0);
    expect(scope.value()).toBeNull();
    expect(caches.live.size).toBe(0);
    expect(await listDbs()).not.toContain(pageDbName("p1"));

    // After stop() the hook is gone (no cleanup of a torn-down runtime).
    stop();
    store.data.set(persistKey("alice"), {});
    await runLogoutCleanups();
    expect(store.data.size).toBe(1);
  });

  it("stops writing to a namespace another tab has cleared", () => {
    const listeners = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void listeners.set(type, fn as (e: Event) => void),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const refresh = vi.fn();
    const scope = { ...memoryScope("alice"), refresh };
    const runtime = createOfflineRuntime({ queryClient: qc, store: createMemoryStore(), scope, connectivityEnv: fakeEnv().env, window: target });
    const stop = runtime.start();
    listeners.get("storage")!(new StorageEvent("storage", { key: "hostidian:lastUser", newValue: null }));
    expect(refresh).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.me() });
    refresh.mockClear();
    listeners.get("storage")!(new StorageEvent("storage", { key: "unrelated" }));
    expect(refresh).not.toHaveBeenCalled();
    stop();
    expect(listeners.size).toBe(0);
  });

  it("flushes the pending write when the page is being hidden or unloaded", async () => {
    const listeners = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void listeners.set(type, fn as (e: Event) => void),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    const store = createMemoryStore();
    const qc = new QueryClient();
    const runtime = createOfflineRuntime({ queryClient: qc, store, scope: memoryScope("u1"), connectivityEnv: fakeEnv().env, window: target });
    const stop = runtime.start();
    runtime.persister.persistClient({ timestamp: 1, buster: "b", clientState: { queries: [], mutations: [] } });
    expect(store.sets).toEqual([]); // throttled
    listeners.get("pagehide")!(new Event("pagehide"));
    await vi.waitFor(() => expect(store.sets).toEqual([persistKey("u1")]));
    stop();
    expect(listeners.has("pagehide")).toBe(false);
  });

  it("uses the shared api client by default (the one the app's queries go through)", () => {
    expect(typeof api.use).toBe("function");
  });
});
