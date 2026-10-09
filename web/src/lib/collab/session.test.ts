import type { CollabToken } from "@hostidian/api-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ApiError } from "@/lib/api/error";
import {
  CONNECTING_GRACE_MS,
  createCollabSession,
  IDB_TIMEOUT_MS,
  type CollabDeps,
  type CollabSession,
  type IdbLike,
  type ProviderConfig,
  type ProviderLike,
} from "./session";

const PAGE_ID = "0199c9a0-aaaa-7bbb-8ccc-0123456789ab";
const USER = { id: "u1", name: "Ada", color: "#ff8800" };

class FakeProvider implements ProviderLike {
  handlers = new Map<string, Array<(payload: unknown) => void>>();
  synced = false;
  isAuthenticated = false;
  unsyncedChanges = 0;
  disconnect = vi.fn();
  connect = vi.fn();
  destroy = vi.fn();
  constructor(readonly config: ProviderConfig) {}
  on(event: string, handler: (payload: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

class FakeIdb implements IdbLike {
  resolve!: () => void;
  whenSynced = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
  destroy = vi.fn();
  clearData = vi.fn(() => Promise.resolve());
}

function token(overrides: Partial<CollabToken> = {}): CollabToken {
  return {
    token: "jwt-1",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    role: "edit",
    wsUrl: "ws://localhost/collab",
    documentName: `page:${PAGE_ID}`,
    ...overrides,
  };
}

const notFound = () => ApiError.fromResponse(404, { error: { code: "not_found", message: "nope" } });
const status = (s: number) => ApiError.fromResponse(s, undefined);

interface Harness {
  deps: CollabDeps;
  idb: FakeIdb;
  createIdb: ReturnType<typeof vi.fn>;
  providers: FakeProvider[];
  fetchToken: ReturnType<typeof vi.fn>;
  pending: { value: boolean };
  online: { value: boolean };
  onUnauthorized: ReturnType<typeof vi.fn>;
}

function harness(fetchImpl?: () => Promise<CollabToken>): Harness {
  const idb = new FakeIdb();
  const providers: FakeProvider[] = [];
  const online = { value: true };
  const pending = { value: false };
  const onUnauthorized = vi.fn();
  const fetchToken = vi.fn(fetchImpl ?? (() => Promise.resolve(token())));
  const createIdb = vi.fn(() => idb);
  const deps: CollabDeps = {
    createIdb,
    createProvider: (config) => {
      const provider = new FakeProvider(config);
      providers.push(provider);
      return provider;
    },
    fetchToken,
    isOnline: () => online.value,
    now: () => Date.now(),
    hasPendingCreate: () => pending.value,
    onUnauthorized,
  };
  return { deps, idb, createIdb, providers, fetchToken, pending, online, onUnauthorized };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
/** Run the deferred connect timer and let the token promise settle. */
const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

describe("createCollabSession", () => {
  let session: CollabSession | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    session?.destroy();
    session = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const create = (h: Harness) => {
    session = createCollabSession({ pageId: PAGE_ID.toUpperCase(), user: USER }, h.deps);
    return session;
  };

  it("names the IndexedDB database and document page:<id> (lower-cased) and is idle until started", () => {
    const h = harness();
    const s = create(h);
    expect(s.documentName).toBe(`page:${PAGE_ID}`);
    expect(s.fragment).toBe(s.doc.getXmlFragment("blocknote"));
    expect(h.createIdb).not.toHaveBeenCalled();
    s.start();
    expect(h.createIdb).toHaveBeenCalledWith(`page:${PAGE_ID}`, s.doc);
  });

  it("is ready for the editor as soon as IndexedDB has loaded, before any network", async () => {
    const h = harness(() => new Promise(() => undefined)); // token request never answers
    const s = create(h);
    s.start();
    expect(s.getSnapshot().localReady).toBe(false);
    h.idb.resolve();
    await tick();
    expect(s.getSnapshot().localReady).toBe(true);
    expect(s.getSnapshot().connection).toBe("connecting");
  });

  it("reports contentReady when the restored doc has content", async () => {
    const h = harness(() => new Promise(() => undefined));
    const s = create(h);
    s.start();
    const para = new Y.XmlElement("blockContainer");
    s.fragment.insert(0, [para]);
    h.idb.resolve();
    await tick();
    expect(s.getSnapshot().contentReady).toBe(true);
  });

  it("falls back to an empty doc when IndexedDB never answers", async () => {
    const h = harness(() => new Promise(() => undefined));
    const s = create(h);
    s.start();
    await tick(IDB_TIMEOUT_MS + 1);
    expect(s.getSnapshot().localReady).toBe(true);
  });

  it("falls back to an empty doc when IndexedDB can't be opened", () => {
    const h = harness(() => new Promise(() => undefined));
    h.createIdb.mockImplementation(() => {
      throw new Error("denied");
    });
    const s = create(h);
    s.start();
    expect(s.getSnapshot().localReady).toBe(true);
  });

  it("creates the provider after the first token, with the server's url, name and a token function", async () => {
    const h = harness();
    const s = create(h);
    s.start();
    expect(h.fetchToken).not.toHaveBeenCalled(); // deferred (StrictMode safety)
    await tick();
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    expect(h.providers).toHaveLength(1);
    const { config } = h.providers[0]!;
    expect(config.url).toBe("ws://localhost/collab");
    expect(config.name).toBe(`page:${PAGE_ID}`);
    expect(config.document).toBe(s.doc);
    expect(config.awareness).toBe(s.awareness);
    expect(s.getSnapshot().role).toBe("edit");

    // First send reuses the bootstrap token; reconnects fetch a fresh one.
    await expect(config.token()).resolves.toBe("jwt-1");
    expect(h.fetchToken).toHaveBeenCalledTimes(1);
    h.fetchToken.mockResolvedValueOnce(token({ token: "jwt-2", role: "view" }));
    await expect(config.token()).resolves.toBe("jwt-2");
    expect(h.fetchToken).toHaveBeenCalledTimes(2);
    expect(s.getSnapshot().role).toBe("view");
  });

  it("does not send a bootstrap token that is about to expire", async () => {
    const h = harness(() => Promise.resolve(token({ expiresAt: new Date(Date.now() + 5_000).toISOString() })));
    const s = create(h);
    s.start();
    await tick();
    h.fetchToken.mockResolvedValueOnce(token({ token: "fresh" }));
    await expect(h.providers[0]!.config.token()).resolves.toBe("fresh");
  });

  it("walks connecting → synced → syncing → offline from provider events", async () => {
    const h = harness();
    const s = create(h);
    s.start();
    await tick();
    const p = h.providers[0]!;
    expect(s.getSnapshot().connection).toBe("connecting");

    p.emit("status", { status: "connected" });
    p.emit("authenticated", { scope: "read-write" });
    p.emit("synced", { state: true });
    expect(s.getSnapshot().connection).toBe("synced");
    expect(s.getSnapshot().contentReady).toBe(true);

    p.emit("unsyncedChanges", { number: 2 });
    expect(s.getSnapshot().connection).toBe("syncing");
    p.emit("unsyncedChanges", { number: 0 });
    expect(s.getSnapshot().connection).toBe("synced");

    p.emit("status", { status: "disconnected" });
    p.emit("close", { event: { code: 1006 } });
    expect(s.getSnapshot().connection).toBe("connecting"); // grace period
    await tick(CONNECTING_GRACE_MS + 1);
    expect(s.getSnapshot().connection).toBe("offline");

    p.emit("status", { status: "connected" });
    p.emit("authenticated", { scope: "read-write" });
    p.emit("synced", { state: true });
    expect(s.getSnapshot().connection).toBe("synced");
  });

  it("never shows 'syncing' on read-only connections", async () => {
    const h = harness(() => Promise.resolve(token({ role: "comment" })));
    const s = create(h);
    s.start();
    await tick();
    const p = h.providers[0]!;
    p.emit("status", { status: "connected" });
    p.emit("authenticated", { scope: "readonly" });
    p.emit("synced", { state: true });
    p.emit("unsyncedChanges", { number: 1 });
    expect(s.getSnapshot().connection).toBe("synced");
    expect(s.getSnapshot().role).toBe("comment");
  });

  it("notifies subscribers only when the snapshot changes", async () => {
    const h = harness();
    const s = create(h);
    const listener = vi.fn();
    s.subscribe(listener);
    s.start();
    await tick();
    const p = h.providers[0]!;
    const before = listener.mock.calls.length;
    p.emit("unsyncedChanges", { number: 0 }); // no visible change
    p.emit("unsyncedChanges", { number: 0 });
    expect(listener.mock.calls.length).toBe(before);
    p.emit("status", { status: "connected" });
    p.emit("authenticated", {});
    p.emit("synced", { state: true });
    expect(listener.mock.calls.length).toBeGreaterThan(before);
  });

  describe("access", () => {
    it("a 404 on the token means no access: no provider, local copy wiped", async () => {
      const h = harness(() => Promise.reject(notFound()));
      const s = create(h);
      s.start();
      await tick();
      expect(h.providers).toHaveLength(0);
      expect(s.getSnapshot().connection).toBe("no-access");
      expect(s.getSnapshot().failure?.kind).toBe("no-access");
      expect(h.idb.clearData).toHaveBeenCalledTimes(1);
      await tick(60_000);
      expect(h.fetchToken).toHaveBeenCalledTimes(1); // not retried
    });

    it("a 404 for a page whose creation is still queued is retried, not treated as no access", async () => {
      const h = harness();
      h.pending.value = true;
      h.fetchToken.mockRejectedValueOnce(notFound());
      const s = create(h);
      s.start();
      await tick();
      expect(s.getSnapshot().failure).toBeNull();
      expect(h.idb.clearData).not.toHaveBeenCalled();
      expect(h.providers).toHaveLength(0);
      h.pending.value = false;
      await tick(2_000); // first back-off step
      expect(h.providers).toHaveLength(1);
      expect(s.getSnapshot().failure).toBeNull();
    });

    it("revocation while connected: the reconnect's token request 404s → no access", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      await tick();
      const p = h.providers[0]!;
      p.emit("status", { status: "connected" });
      p.emit("authenticated", {});
      p.emit("synced", { state: true });

      await p.config.token(); // the initial connection used the bootstrap token

      // Server closes the socket (4205); the provider reconnects and asks for a token again.
      h.fetchToken.mockRejectedValueOnce(notFound());
      await expect(p.config.token()).rejects.toBeInstanceOf(ApiError);
      p.emit("authenticationFailed", { reason: "Failed to get token during sendToken(): ApiError" });
      expect(s.getSnapshot().connection).toBe("no-access");
      expect(p.disconnect).toHaveBeenCalled();
      expect(h.idb.clearData).toHaveBeenCalled();
    });

    it("a 401 ends the session: error state and the unauthorized hook", async () => {
      const h = harness(() => Promise.reject(status(401)));
      const s = create(h);
      s.start();
      await tick();
      expect(s.getSnapshot().connection).toBe("error");
      expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
      expect(h.idb.clearData).not.toHaveBeenCalled();
    });

    it("a 403 is a configuration problem: error state, local data kept", async () => {
      const h = harness(() => Promise.reject(status(403)));
      const s = create(h);
      s.start();
      await tick();
      expect(s.getSnapshot().connection).toBe("error");
      expect(h.idb.clearData).not.toHaveBeenCalled();
    });
  });

  describe("connectivity", () => {
    it("retries the token request with back-off after a network error, and creates the provider on success", async () => {
      const h = harness();
      h.fetchToken.mockRejectedValueOnce(ApiError.network()).mockRejectedValueOnce(status(503));
      const s = create(h);
      s.start();
      await tick();
      expect(h.providers).toHaveLength(0);
      expect(s.getSnapshot().failure).toBeNull();
      await tick(30_000);
      expect(h.fetchToken.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(h.providers).toHaveLength(1);
    });

    it("reads as offline right away when the browser is offline, and retries when it comes back", async () => {
      const h = harness();
      h.online.value = false;
      h.fetchToken.mockRejectedValueOnce(ApiError.network());
      const s = create(h);
      s.start();
      await tick();
      expect(s.getSnapshot().connection).toBe("offline");
      expect(h.providers).toHaveLength(0);

      h.online.value = true;
      window.dispatchEvent(new Event("online"));
      await tick();
      expect(h.providers).toHaveLength(1);
    });

    it("nudges a disconnected provider when the network returns", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      await tick();
      const p = h.providers[0]!;
      window.dispatchEvent(new Event("online"));
      expect(p.connect).toHaveBeenCalled();
      expect(s.getSnapshot().role).toBe("edit");
    });

    it("reconnects with a fresh token after the server rejects an expired one", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      await tick();
      const p = h.providers[0]!;
      p.emit("authenticationFailed", { reason: "token-expired" });
      expect(p.disconnect).not.toHaveBeenCalled(); // waits for the back-off first
      await tick(1_100);
      expect(p.disconnect).toHaveBeenCalledTimes(1);
      await tick(300);
      expect(p.connect).toHaveBeenCalledTimes(1);
      expect(s.getSnapshot().failure).toBeNull();
    });

    it("surfaces a misconfigured origin as a soft error that clears once authenticated", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      await tick();
      const p = h.providers[0]!;
      p.emit("authenticationFailed", { reason: "forbidden-origin" });
      expect(s.getSnapshot().connection).toBe("error");
      await tick(1_300);
      expect(p.connect).toHaveBeenCalled(); // keeps trying
      p.emit("status", { status: "connected" });
      p.emit("authenticated", {});
      p.emit("synced", { state: true });
      expect(s.getSnapshot().connection).toBe("synced");
    });
  });

  describe("lifecycle", () => {
    it("destroying before the deferred start opens no socket and spends no token (StrictMode)", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      s.destroy();
      await tick(10);
      expect(h.fetchToken).not.toHaveBeenCalled();
      expect(h.providers).toHaveLength(0);
    });

    it("tears down provider, IndexedDB and doc after children had a chance to unmount", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      await tick();
      const p = h.providers[0]!;
      const destroyed = vi.fn();
      s.doc.on("destroy", destroyed);
      s.destroy();
      expect(p.destroy).not.toHaveBeenCalled();
      await tick(1);
      expect(p.destroy).toHaveBeenCalledTimes(1);
      expect(h.idb.destroy).toHaveBeenCalledTimes(1);
      expect(destroyed).toHaveBeenCalledTimes(1);
      s.destroy(); // idempotent
      await tick(1);
      expect(p.destroy).toHaveBeenCalledTimes(1);
    });

    it("ignores events and token results that arrive after destroy", async () => {
      let resolveToken!: (t: CollabToken) => void;
      const h = harness(() => new Promise<CollabToken>((resolve) => (resolveToken = resolve)));
      const s = create(h);
      s.start();
      await tick();
      s.destroy();
      resolveToken(token());
      await tick(10);
      expect(h.providers).toHaveLength(0);
    });

    it("start() is idempotent and stops listening to window events after destroy", async () => {
      const h = harness();
      const s = create(h);
      s.start();
      s.start();
      expect(h.createIdb).toHaveBeenCalledTimes(1);
      await tick();
      const p = h.providers[0]!;
      s.destroy();
      window.dispatchEvent(new Event("online"));
      expect(p.connect).not.toHaveBeenCalled();
    });
  });
});
