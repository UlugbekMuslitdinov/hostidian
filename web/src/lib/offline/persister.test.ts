import "fake-indexeddb/auto";
import { QueryClient, dehydrate } from "@tanstack/react-query";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSIST_BUSTER,
  PERSIST_KEY_PREFIX,
  PERSIST_MAX_AGE_MS,
  createIdbKeyValueStore,
  createOfflinePersister,
  dehydrateOptions,
  isPersistableQueryKey,
  isPersistedClient,
  isQuotaError,
  persistKey,
  sanitizeForPersist,
  shouldPersistMutation,
  shrinkForQuota,
  type PersistState,
} from "./persister";
import { QuotaError, createMemoryStore } from "./test-helpers";
import { CACHE_MAX_AGE_MS } from "../query/client";

function snapshot(overrides: Partial<PersistedClient["clientState"]> = {}): PersistedClient {
  return {
    timestamp: 1,
    buster: PERSIST_BUSTER,
    clientState: { queries: [], mutations: [], ...overrides },
  };
}

type Query = PersistedClient["clientState"]["queries"][number];
const query = (queryKey: unknown[], extra: Partial<Query["state"]> = {}): Query =>
  ({
    queryKey,
    queryHash: JSON.stringify(queryKey),
    state: {
      data: { ok: true },
      dataUpdateCount: 1,
      dataUpdatedAt: 1,
      error: new Error("boom"),
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 3,
      fetchFailureReason: new Error("flaky"),
      fetchMeta: null,
      isInvalidated: false,
      status: "success",
      fetchStatus: "fetching",
      ...extra,
    },
  }) as unknown as Query;

describe("what is persisted", () => {
  it("keeps the identity, the workspace tree and page data; drops ephemeral and sensitive queries", () => {
    for (const key of [["me"], ["instance"], ["workspace", "w", "pages"], ["workspace", "w", "favorites"], ["page", "p"], ["page", "p", "backlinks"]]) {
      expect(isPersistableQueryKey(key), JSON.stringify(key)).toBe(true);
    }
    for (const key of [
      ["workspace", "w", "search", "full", "secret"],
      ["workspace", "w", "invites"],
      ["page", "p", "permissions"],
      ["page", "p", "shares"],
      ["sessions"],
      ["admin", "users"],
      ["invite", "token"],
    ]) {
      expect(isPersistableQueryKey(key), JSON.stringify(key)).toBe(false);
    }
  });

  it("persists a mutation only while it is unfinished and replayable by key", () => {
    const mutation = (status: string, mutationKey?: string[], mutationFn: unknown = () => undefined) =>
      ({ state: { status }, options: { mutationKey, mutationFn } }) as never;
    expect(shouldPersistMutation(mutation("pending", ["createPage"]))).toBe(true);
    expect(shouldPersistMutation(mutation("success", ["createPage"]))).toBe(false);
    expect(shouldPersistMutation(mutation("error", ["createPage"]))).toBe(false);
    expect(shouldPersistMutation(mutation("pending", undefined))).toBe(false);
  });

  it("dehydrates paused mutations and successful queries of a real client", async () => {
    const qc = new QueryClient();
    qc.setMutationDefaults(["createPage"], { mutationFn: () => new Promise(() => undefined), scope: { id: "pages" } });
    await qc.prefetchQuery({ queryKey: ["workspace", "w", "pages"], queryFn: () => [{ id: "a" }] });
    await qc.prefetchQuery({ queryKey: ["workspace", "w", "search", "full", "q"], queryFn: () => [] });
    void qc.getMutationCache().build(qc, { mutationKey: ["createPage"] }).execute({ id: "x" });
    const state = dehydrate(qc, dehydrateOptions);
    expect(state.queries.map((q) => q.queryKey)).toEqual([["workspace", "w", "pages"]]);
    expect(state.mutations).toHaveLength(1);
    expect(state.mutations[0]).toMatchObject({ mutationKey: ["createPage"], scope: { id: "pages" } });
  });
});

describe("sanitizeForPersist", () => {
  it("stores unfinished mutations as paused and drops rollback snapshots and errors", () => {
    const client = snapshot({
      queries: [query(["workspace", "w", "pages"])],
      mutations: [
        {
          mutationKey: ["createPage"],
          state: {
            context: { snapshots: [["huge", 1]] },
            data: undefined,
            error: new Error("x"),
            failureCount: 4,
            failureReason: new Error("net"),
            isPaused: false,
            status: "pending",
            variables: { id: "p1" },
            submittedAt: 5,
          },
        },
      ],
    });
    const out = sanitizeForPersist(client);
    expect(out.clientState.mutations[0]!.state).toMatchObject({
      isPaused: true,
      context: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      variables: { id: "p1" },
    });
    expect(out.clientState.queries[0]!.state).toMatchObject({ fetchStatus: "idle", error: null, fetchFailureCount: 0 });
    // Pure: the input is untouched.
    expect(client.clientState.mutations[0]!.state.isPaused).toBe(false);
  });

  it("shrinks to the essentials, then to the identity, when storage is full", () => {
    const client = snapshot({
      queries: [query(["me"]), query(["workspace", "w", "pages"]), query(["page", "p"]), query(["page", "p", "backlinks"]), query(["workspace", "w", "graph"])],
      mutations: [{ mutationKey: ["x"], state: {} as never }],
    });
    expect(shrinkForQuota(client, 1).clientState.queries.map((q) => q.queryKey)).toEqual([
      ["me"],
      ["workspace", "w", "pages"],
      ["page", "p"],
    ]);
    const tiny = shrinkForQuota(client, 2);
    expect(tiny.clientState.queries.map((q) => q.queryKey)).toEqual([["me"]]);
    expect(tiny.clientState.mutations).toHaveLength(1); // queued edits are never dropped
  });
});

describe("validation helpers", () => {
  it("accepts only well-formed snapshots", () => {
    expect(isPersistedClient(snapshot())).toBe(true);
    for (const bad of [null, undefined, 1, "x", {}, { timestamp: 1, buster: "b" }, { timestamp: 1, buster: "b", clientState: { queries: [] } }]) {
      expect(isPersistedClient(bad)).toBe(false);
    }
  });

  it("recognises quota errors across browsers", () => {
    expect(isQuotaError(new QuotaError())).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError({ message: "Quota exceeded" })).toBe(true);
    expect(isQuotaError(new Error("nope"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });

  it("keeps in-memory queries at least as long as the persisted cache is valid (TanStack requirement)", () => {
    expect(CACHE_MAX_AGE_MS).toBeGreaterThanOrEqual(PERSIST_MAX_AGE_MS);
  });
});

describe("createOfflinePersister", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (userId: string | null = "u1", store = createMemoryStore()) => {
    let current = userId;
    const states: PersistState[] = [];
    const persister = createOfflinePersister({ store, getUserId: () => current, onStatus: (s) => states.push(s), throttleMs: 1000, mutationThrottleMs: 50 });
    return { persister, store, states, setUser: (u: string | null) => (current = u) };
  };

  it("writes the snapshot into the signed-in user's namespace after the throttle", async () => {
    const { persister, store, states } = make("u1");
    persister.persistClient(snapshot({ queries: [query(["me"])] }));
    expect(store.sets).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.sets).toEqual([persistKey("u1")]);
    expect(persistKey("u1").startsWith(PERSIST_KEY_PREFIX)).toBe(true);
    expect(states).toEqual(["ok"]);
    // Errors are stripped before writing.
    const written = store.data.get(persistKey("u1")) as PersistedClient;
    expect(written.clientState.queries[0]!.state.error).toBeNull();
  });

  it("writes queued mutations quickly: losing them is the costly case", async () => {
    const { persister, store } = make("u1");
    const mutation = { mutationKey: ["createPage"], state: { isPaused: true, status: "pending", variables: {} } as never };
    persister.persistClient(snapshot({ mutations: [mutation] }));
    await vi.advanceTimersByTimeAsync(50);
    expect(store.sets).toEqual([persistKey("u1")]);
  });

  it("coalesces rapid snapshots into one write of the latest", async () => {
    const { persister, store } = make("u1");
    persister.persistClient(snapshot({ queries: [query(["me"])] }));
    persister.persistClient(snapshot({ queries: [query(["me"]), query(["page", "p"])] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.sets).toHaveLength(1);
    expect((store.data.get(persistKey("u1")) as PersistedClient).clientState.queries).toHaveLength(2);
  });

  it("writes nothing when nobody is signed in", async () => {
    const { persister, store } = make(null);
    persister.persistClient(snapshot());
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.sets).toEqual([]);
    expect(await persister.restoreClient()).toBeUndefined();
  });

  it("never writes a snapshot into another user's slot when the account changes while it waits", async () => {
    const { persister, store, setUser } = make("u1");
    persister.persistClient(snapshot({ queries: [query(["me"])] }));
    setUser("u2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.data.size).toBe(0);
  });

  it("restores only the signed-in user's snapshot", async () => {
    const store = createMemoryStore({ [persistKey("u1")]: snapshot({ queries: [query(["me"])] }), [persistKey("u2")]: snapshot() });
    const { persister, setUser } = make("u1", store);
    expect((await persister.restoreClient())?.clientState.queries).toHaveLength(1);
    setUser("u2");
    expect((await persister.restoreClient())?.clientState.queries).toHaveLength(0);
  });

  it("deletes an unreadable leftover instead of crashing on it", async () => {
    const store = createMemoryStore({ [persistKey("u1")]: { garbage: true } });
    const { persister } = make("u1", store);
    expect(await persister.restoreClient()).toBeUndefined();
    expect(store.data.has(persistKey("u1"))).toBe(false);
  });

  it("starts with an empty cache when storage throws", async () => {
    const store = createMemoryStore();
    store.get = async () => {
      throw new Error("IndexedDB unavailable");
    };
    const { persister } = make("u1", store);
    expect(await persister.restoreClient()).toBeUndefined();
  });

  it("degrades to a smaller snapshot when the disk is full, and reports it", async () => {
    const store = createMemoryStore();
    store.failSetWith = new QuotaError();
    store.failSetTimes = 1;
    const { persister, states } = make("u1", store);
    persister.persistClient(snapshot({ queries: [query(["me"]), query(["workspace", "w", "graph"])] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toEqual(["quota"]);
    expect((store.data.get(persistKey("u1")) as PersistedClient).clientState.queries.map((q) => q.queryKey)).toEqual([["me"]]);
  });

  it("reports unavailable storage for non-quota failures", async () => {
    const store = createMemoryStore();
    store.failSetWith = new Error("SecurityError");
    store.failSetTimes = 1;
    const { persister, states } = make("u1", store);
    persister.persistClient(snapshot());
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toEqual(["unavailable"]);
  });

  it("flush() writes immediately and cancel() drops what has not been written", async () => {
    const { persister, store } = make("u1");
    persister.persistClient(snapshot());
    await persister.flush();
    expect(store.sets).toHaveLength(1);

    persister.persistClient(snapshot());
    persister.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.sets).toHaveLength(1);
  });

  it("removeClient deletes the user's snapshot", async () => {
    const store = createMemoryStore({ [persistKey("u1")]: snapshot() });
    const { persister } = make("u1", store);
    await persister.removeClient();
    expect(store.data.size).toBe(0);
  });
});

describe("createIdbKeyValueStore", () => {
  it("round-trips structured data through IndexedDB and clears it", async () => {
    vi.useRealTimers();
    const store = createIdbKeyValueStore(`test-${Math.random()}`);
    await store.set("a", { n: 1, nested: [1, 2, 3] });
    expect(await store.get("a")).toEqual({ n: 1, nested: [1, 2, 3] });
    await store.del("a");
    expect(await store.get("a")).toBeUndefined();
    await store.set("b", 2);
    await store.clear();
    expect(await store.get("b")).toBeUndefined();
  });
});
