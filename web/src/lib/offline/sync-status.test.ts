import { MutationObserver, QueryClient, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/error";
import { countPendingMutations, createSyncMonitor, deriveSyncKind } from "./sync-status";

describe("deriveSyncKind", () => {
  const error = { title: "t", message: "m", at: 1 };
  it("offline wins over everything", () => {
    expect(deriveSyncKind({ online: false, pending: 3, error })).toBe("offline");
  });
  it("then a failed change, then queued changes, then idle", () => {
    expect(deriveSyncKind({ online: true, pending: 0, error })).toBe("error");
    expect(deriveSyncKind({ online: true, pending: 2, error: null })).toBe("syncing");
    expect(deriveSyncKind({ online: true, pending: 0, error: null })).toBe("online");
  });
});

describe("createSyncMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onlineManager.setOnline(true);
  });
  afterEach(() => vi.useRealTimers());

  function client(mutationFn: () => Promise<unknown>) {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setMutationDefaults(["op"], { mutationFn, meta: { errorTitle: "Couldn't save" }, networkMode: "offlineFirst" });
    return qc;
  }

  it("counts pending mutations, including ones queued while offline", async () => {
    const qc = client(() => new Promise(() => undefined));
    const monitor = createSyncMonitor(qc);
    expect(monitor.store.get().pending).toBe(0);
    void new MutationObserver(qc, { mutationKey: ["op"] }).mutate(1 as never);
    void new MutationObserver(qc, { mutationKey: ["op"] }).mutate(2 as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(countPendingMutations(qc)).toBe(2);
    expect(monitor.store.get().pending).toBe(2);
    monitor.dispose();
  });

  it("goes back to zero when they finish", async () => {
    let finish!: () => void;
    const qc = client(() => new Promise<void>((r) => (finish = r)));
    const monitor = createSyncMonitor(qc);
    void new MutationObserver(qc, { mutationKey: ["op"] }).mutate(1 as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.store.get().pending).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.store.get().pending).toBe(0);
    expect(monitor.store.get().error).toBeNull();
    monitor.dispose();
  });

  it("records a change that failed for good, and clears it on request", async () => {
    const qc = client(async () => {
      throw ApiError.fromResponse(403, { error: { code: "forbidden", message: "You can't edit this" } });
    });
    const monitor = createSyncMonitor(qc, () => 42);
    await new MutationObserver(qc, { mutationKey: ["op"] }).mutate(1 as never).catch(() => undefined);
    expect(monitor.store.get().error).toEqual({ title: "Couldn't save", message: "You can't edit this", at: 42 });
    expect(monitor.store.get().pending).toBe(0);
    monitor.clearError();
    expect(monitor.store.get().error).toBeNull();
    monitor.dispose();
  });

  it("does not treat a signed-out answer as a sync problem", async () => {
    const qc = client(async () => {
      throw ApiError.fromResponse(401, { error: { code: "unauthorized", message: "no" } });
    });
    const monitor = createSyncMonitor(qc);
    await new MutationObserver(qc, { mutationKey: ["op"] }).mutate(1 as never).catch(() => undefined);
    expect(monitor.store.get().error).toBeNull();
    monitor.dispose();
  });
});
