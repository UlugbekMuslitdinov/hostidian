import { describe, expect, it } from "vitest";
import {
  MIN_RESYNC_MS,
  PREFETCH_MAX_AGE_MS,
  RETRY_AFTER_MS,
  createPrefetcher,
  needsSync,
  readPrefetchRecords,
  selectPrefetchTargets,
  writePrefetchRecords,
  type PrefetchCandidate,
  type PrefetchDeps,
} from "./prefetch";
import { OFFLINE_KEYS } from "./keys";

const T0 = Date.parse("2026-10-09T12:00:00Z");
const page = (id: string, updatedAt = "2026-10-09T10:00:00Z", archivedAt: string | null = null): PrefetchCandidate => ({ id, updatedAt, archivedAt });

describe("selectPrefetchTargets", () => {
  it("takes the most recently updated pages, then favorites that are not among them", () => {
    const pages = Array.from({ length: 30 }, (_, i) => page(`p${i}`, `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`));
    const favorites = [pages[0]!, page("fav-1"), page("fav-2")];
    const out = selectPrefetchTargets({ pages, favorites });
    expect(out).toHaveLength(23); // 20 recent + the 3 favorites that are not among them (p0 is too old)
    const ids = out.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // newest first
    const recent = out.slice(0, 20);
    expect(recent.map((p) => p.updatedAt)).toEqual([...recent.map((p) => p.updatedAt)].sort().reverse());
    expect(ids.slice(-3)).toEqual(["p0", "fav-1", "fav-2"]);
  });

  it("caps favorites and skips archived pages", () => {
    const favorites = Array.from({ length: 15 }, (_, i) => page(`f${i}`));
    const out = selectPrefetchTargets({ pages: [page("a"), page("gone", "2026-10-09T11:00:00Z", "2026-10-09T11:30:00Z")], favorites });
    expect(out.map((p) => p.id)).toEqual(["a", ...Array.from({ length: 10 }, (_, i) => `f${i}`)]);
  });

  it("honours custom limits", () => {
    const out = selectPrefetchTargets({ pages: [page("a"), page("b"), page("c")], favorites: [page("z")] }, { recent: 2, favorites: 1 });
    expect(out).toHaveLength(3);
  });
});

describe("needsSync", () => {
  it("syncs pages never synced", () => expect(needsSync(page("a"), undefined, T0)).toBe(true));

  it("re-syncs only when the page changed since the last sync", () => {
    const syncedAt = Date.parse("2026-10-09T10:30:00Z");
    expect(needsSync(page("a", "2026-10-09T10:00:00Z"), syncedAt, T0)).toBe(false);
    expect(needsSync(page("a", "2026-10-09T11:00:00Z"), syncedAt, T0)).toBe(true);
  });

  it("rate-limits re-syncs of a page that keeps changing", () => {
    const syncedAt = T0 - MIN_RESYNC_MS + 1000;
    expect(needsSync(page("a", "2026-10-09T11:59:59Z"), syncedAt, T0)).toBe(false);
  });

  it("refreshes day-old copies even when unchanged", () => {
    expect(needsSync(page("a", "2026-01-01T00:00:00Z"), T0 - PREFETCH_MAX_AGE_MS - 1, T0)).toBe(true);
  });
});

function harness(overrides: Partial<PrefetchDeps> = {}) {
  const synced: string[] = [];
  const concurrent = { now: 0, max: 0 };
  const state = {
    now: T0,
    online: true,
    constrained: false,
    open: new Set<string>(),
    localOnly: new Set<string>(),
    records: {} as Record<string, number>,
    failing: new Set<string>(),
    delay: undefined as undefined | (() => Promise<void>),
    idleCalls: 0,
  };
  const deps: PrefetchDeps = {
    now: () => state.now,
    isOnline: () => state.online,
    isConstrained: () => state.constrained,
    isOpen: (id) => state.open.has(id),
    isLocalOnly: (id) => state.localOnly.has(id),
    syncPage: async (id, signal) => {
      concurrent.now += 1;
      concurrent.max = Math.max(concurrent.max, concurrent.now);
      try {
        await state.delay?.();
        if (signal.aborted) throw new Error("aborted");
        if (state.failing.has(id)) throw new Error("boom");
        synced.push(id);
      } finally {
        concurrent.now -= 1;
      }
    },
    loadRecords: () => ({ ...state.records }),
    saveRecords: (r) => void (state.records = r),
    whenIdle: (fn) => {
      state.idleCalls += 1;
      queueMicrotask(fn);
      return () => undefined;
    },
    ...overrides,
  };
  return { deps, state, synced, concurrent, prefetcher: createPrefetcher(deps) };
}

describe("createPrefetcher", () => {
  it("syncs due pages, two at a time, and records them", async () => {
    const h = harness();
    h.state.delay = () => new Promise((r) => setTimeout(r, 5));
    const result = await h.prefetcher.run(["a", "b", "c", "d", "e"].map((id) => page(id)));
    expect(h.synced.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(result).toMatchObject({ failed: [], interrupted: false });
    expect(h.concurrent.max).toBe(2);
    expect(Object.keys(h.state.records).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(h.state.idleCalls).toBeGreaterThan(0); // work is scheduled in idle time
  });

  it("does not sync pages that are up to date", async () => {
    const h = harness();
    h.state.records = { a: T0 - 60 * 60 * 1000 };
    const result = await h.prefetcher.run([page("a", "2026-10-09T10:00:00Z"), page("b")]);
    expect(h.synced).toEqual(["b"]);
    expect(result.skipped).toBe(1);
  });

  it("re-syncs a page that changed on the server since", async () => {
    const h = harness();
    h.state.records = { a: Date.parse("2026-10-09T10:30:00Z") };
    await h.prefetcher.run([page("a", "2026-10-09T11:30:00Z")]);
    expect(h.synced).toEqual(["a"]);
  });

  it("never touches the open page or pages created offline", async () => {
    const h = harness();
    h.state.open.add("open");
    h.state.localOnly.add("local");
    await h.prefetcher.run([page("open"), page("local"), page("other")]);
    expect(h.synced).toEqual(["other"]);
  });

  it("does nothing offline, on Save-Data connections or when storage is nearly full", async () => {
    for (const mutate of [
      (h: ReturnType<typeof harness>) => (h.state.online = false),
      (h: ReturnType<typeof harness>) => (h.state.constrained = true),
    ]) {
      const h = harness();
      mutate(h);
      const result = await h.prefetcher.run([page("a"), page("b")]);
      expect(h.synced).toEqual([]);
      expect(result.interrupted).toBe(true);
    }
  });

  it("stops mid-pass when the connection drops", async () => {
    const h = harness();
    h.state.delay = async () => {
      h.state.online = false; // goes offline during the first sync
    };
    const result = await h.prefetcher.run(["a", "b", "c", "d"].map((id) => page(id)));
    expect(h.synced.length).toBeLessThan(4);
    expect(result.interrupted).toBe(true);
  });

  it("does not retry a failing page right away, but does after the retry delay", async () => {
    const h = harness();
    h.state.failing.add("bad");
    const first = await h.prefetcher.run([page("bad"), page("good")]);
    expect(first.failed).toEqual(["bad"]);
    expect(h.synced).toEqual(["good"]);

    h.state.failing.clear();
    await h.prefetcher.run([page("bad")]);
    expect(h.synced).toEqual(["good"]); // still cooling down

    h.state.now += RETRY_AFTER_MS + 1;
    await h.prefetcher.run([page("bad")]);
    expect(h.synced).toEqual(["good", "bad"]);
  });

  it("re-syncs a page whose IndexedDB database was evicted although the bookkeeping says it is fresh", async () => {
    const h = harness({ hasLocalCopy: async (id) => id !== "evicted" });
    h.state.records = { evicted: T0 - 1000, intact: T0 - 1000 };
    await h.prefetcher.run([page("evicted", "2026-01-01T00:00:00Z"), page("intact", "2026-01-01T00:00:00Z")]);
    expect(h.synced).toEqual(["evicted"]);
  });

  it("aborts a page's sync when its editor opens, without counting it as a failure", async () => {
    const h = harness();
    let release!: () => void;
    h.state.delay = () => new Promise<void>((r) => (release = r));
    const running = h.prefetcher.run([page("a")]);
    await new Promise((r) => setTimeout(r, 0));
    h.prefetcher.cancelPage("a");
    release();
    const result = await running;
    expect(result.failed).toEqual([]);
    expect(h.synced).toEqual([]);
    expect(h.state.records.a).toBeUndefined();
  });

  it("coalesces overlapping runs: the latest list is processed after the current pass", async () => {
    const h = harness();
    let release!: () => void;
    h.state.delay = () => new Promise<void>((r) => (release = r));
    const first = h.prefetcher.run([page("a")]);
    await new Promise((r) => setTimeout(r, 0));
    const second = h.prefetcher.run([page("a"), page("b")]);
    h.state.delay = undefined;
    release();
    await Promise.all([first, second]);
    expect(h.synced).toEqual(["a", "b"]);
  });

  it("refuses to run after stop()", async () => {
    const h = harness();
    h.prefetcher.stop();
    const result = await h.prefetcher.run([page("a")]);
    expect(h.synced).toEqual([]);
    expect(result.interrupted).toBe(true);
  });
});

describe("prefetch bookkeeping", () => {
  it("round-trips per user and ignores corrupt entries", () => {
    window.localStorage.clear();
    writePrefetchRecords("u1", { a: 1, b: 2 });
    expect(readPrefetchRecords("u1")).toEqual({ a: 1, b: 2 });
    expect(readPrefetchRecords("u2")).toEqual({});
    window.localStorage.setItem(OFFLINE_KEYS.prefetch("u3"), JSON.stringify({ ok: 5, bad: "x", worse: null }));
    expect(readPrefetchRecords("u3")).toEqual({ ok: 5 });
    window.localStorage.setItem(OFFLINE_KEYS.prefetch("u4"), "[1,2]");
    expect(readPrefetchRecords("u4")).toEqual({});
  });
});
