import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import type { CollabToken } from "@hostidian/api-types";
import {
  FLUSH_LOCAL_CHANGES_MS,
  PageSyncError,
  syncPageDocument,
  type PageSyncDeps,
  type PrefetchProvider,
} from "./prefetch-sync";

const TOKEN: CollabToken = {
  token: "jwt",
  expiresAt: "2026-10-09T12:02:00Z",
  role: "edit",
  wsUrl: "ws://localhost/collab",
  documentName: "page:0190ABCD-0000-7000-8000-000000000001",
};

function make(options: { unsynced?: number } = {}) {
  const events = new Map<string, (payload?: unknown) => void>();
  const log: string[] = [];
  const timers: Array<{ ms: number; fn: () => void }> = [];
  let idbName = "";
  let awareness: { getLocalState(): unknown } | null = null;
  const provider: PrefetchProvider = {
    on: (event, handler) => void events.set(event, handler as never),
    destroy: () => void log.push("provider.destroy"),
    synced: false,
    unsyncedChanges: options.unsynced ?? 0,
  };
  const deps: PageSyncDeps = {
    fetchToken: vi.fn(async () => TOKEN),
    createIdb: (name) => {
      idbName = name;
      log.push("idb.open");
      return {
        whenSynced: Promise.resolve(),
        destroy: () => void log.push("idb.destroy"),
      };
    },
    createProvider: (config) => {
      log.push("provider.create");
      awareness = config.awareness;
      expect(config.token).toBe("jwt");
      expect(config.name).toBe(TOKEN.documentName);
      return provider;
    },
    setTimeout: (fn, ms) => {
      timers.push({ ms, fn });
      return timers.length - 1;
    },
    clearTimeout: () => undefined,
  };
  return { deps, events, log, timers, name: () => idbName, awareness: () => awareness };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("syncPageDocument", () => {
  it("fills the editor's IndexedDB (page:<lowercased id>) from the server, then releases everything", async () => {
    const h = make();
    const done = syncPageDocument("0190ABCD-0000-7000-8000-000000000001", new AbortController().signal, h.deps);
    await tick();
    h.events.get("synced")!();
    await done;
    expect(h.name()).toBe("page:0190abcd-0000-7000-8000-000000000001");
    expect(h.log).toEqual(["idb.open", "provider.create", "provider.destroy", "idb.destroy"]);
    // Headless: it must not appear in anyone's presence stack.
    expect(h.awareness()!.getLocalState()).toBeNull();
  });

  it("waits for edits that were still queued on this device to reach the server", async () => {
    const h = make({ unsynced: 2 });
    let settled = false;
    const done = syncPageDocument("p", new AbortController().signal, h.deps).then(() => (settled = true));
    await tick();
    h.events.get("synced")!();
    await tick();
    expect(settled).toBe(false);
    h.events.get("unsyncedChanges")!({ number: 0 });
    await done;
    expect(settled).toBe(true);
  });

  it("does not wait forever for acknowledgements", async () => {
    const h = make({ unsynced: 1 });
    const done = syncPageDocument("p", new AbortController().signal, h.deps);
    await tick();
    h.events.get("synced")!();
    h.timers.find((t) => t.ms === FLUSH_LOCAL_CHANGES_MS)!.fn();
    await done;
  });

  it("rejects when the server refuses the connection, and still cleans up", async () => {
    const h = make();
    const done = syncPageDocument("p", new AbortController().signal, h.deps);
    await tick();
    h.events.get("authenticationFailed")!();
    await expect(done).rejects.toMatchObject({ reason: "auth" });
    expect(h.log).toContain("provider.destroy");
    expect(h.log).toContain("idb.destroy");
  });

  it("times out", async () => {
    const h = make();
    const done = syncPageDocument("p", new AbortController().signal, h.deps, 1234);
    await tick();
    h.timers.find((t) => t.ms === 1234)!.fn();
    await expect(done).rejects.toBeInstanceOf(PageSyncError);
    await expect(done).rejects.toMatchObject({ reason: "timeout" });
  });

  it("can be aborted before and during the sync", async () => {
    const before = new AbortController();
    before.abort();
    const h1 = make();
    await expect(syncPageDocument("p", before.signal, h1.deps)).rejects.toMatchObject({ reason: "aborted" });
    expect(h1.log).toEqual([]); // never even opened IndexedDB

    const during = new AbortController();
    const h2 = make();
    const done = syncPageDocument("p", during.signal, h2.deps);
    await tick();
    during.abort();
    await expect(done).rejects.toMatchObject({ reason: "aborted" });
    expect(h2.log).toContain("idb.destroy");
  });

  it("propagates a failing token request without touching IndexedDB", async () => {
    const h = make();
    h.deps.fetchToken = vi.fn(async () => {
      throw new Error("404");
    });
    await expect(syncPageDocument("p", new AbortController().signal, h.deps)).rejects.toThrow("404");
    expect(h.log).toEqual([]);
  });

  it("is real Yjs under the hood (smoke): a doc can be created and destroyed", () => {
    const doc = new Y.Doc();
    doc.destroy();
  });
});
