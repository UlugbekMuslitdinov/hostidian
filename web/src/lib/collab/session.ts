import { HocuspocusProvider } from "@hocuspocus/provider";
import type { CollabToken, EffectiveRole } from "@hostidian/api-types";
import { YDOC_FRAGMENT } from "@hostidian/editor-schema/react";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  classifyAuthFailure,
  deriveConnection,
  reconnectDelay,
  type ConnectionState,
} from "./connection";
import { classifyTokenError, fetchCollabToken } from "./token";

/**
 * One page's collaboration session: a Y.Doc persisted in IndexedDB (database name = document name,
 * `page:<pageId>`, so the offline layer can find it) and a Hocuspocus connection that is established
 * independently of it.
 *
 * Why the two are decoupled: the page must open from IndexedDB with no network at all, edits made offline
 * are ordinary Yjs updates that merge on reconnect, and the socket URL/JWT come from an authenticated API
 * call that can fail (offline, 5xx) without that being a reason to refuse the local copy. So the doc and
 * its Awareness exist (and the editor can bind to them) before any provider does; the provider is created
 * once the first token has been fetched, and a provider that loses its token mid-life (server-side
 * revocation closes sockets with code 4205) simply fetches a fresh one when it reconnects.
 *
 * The class-free, dependency-injected shape keeps all of this testable without sockets or IndexedDB.
 */

export interface CollabUserInfo {
  id: string;
  name: string;
  color: string;
}

export interface IdbLike {
  whenSynced: Promise<unknown>;
  destroy(): Promise<unknown> | void;
  clearData(): Promise<unknown>;
}

export interface ProviderConfig {
  url: string;
  name: string;
  document: Y.Doc;
  awareness: Awareness;
  token: () => Promise<string>;
}

export interface ProviderLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  connect(): unknown;
  disconnect(): void;
  destroy(): void;
  readonly synced: boolean;
  readonly isAuthenticated: boolean;
  readonly unsyncedChanges: number;
}

export interface CollabDeps {
  createIdb(name: string, doc: Y.Doc): IdbLike;
  createProvider(config: ProviderConfig): ProviderLike;
  fetchToken(pageId: string): Promise<CollabToken>;
  isOnline(): boolean;
  now(): number;
  /** The page was created offline and its `createPage` mutation hasn't reached the server yet. */
  hasPendingCreate(pageId: string): boolean;
  /** The API says our session is over (401 on the token endpoint). */
  onUnauthorized(): void;
}

export interface CollabFailure {
  kind: "no-access" | "error";
  message: string;
}

export interface CollabSnapshot {
  /** The doc has been restored from IndexedDB (or IndexedDB is unavailable): safe to bind an editor. */
  localReady: boolean;
  /** The doc holds real content: restored from this device or received from the server. */
  contentReady: boolean;
  connection: ConnectionState;
  /** Role from the last collab token; `null` until one was issued. Read-only roles stay read-only here. */
  role: EffectiveRole | null;
  failure: CollabFailure | null;
}

export interface CollabSession {
  readonly pageId: string;
  readonly documentName: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly fragment: Y.XmlFragment;
  getSnapshot(): CollabSnapshot;
  subscribe(listener: () => void): () => void;
  /** Open IndexedDB and start connecting. Idempotent. */
  start(): void;
  /** Stop everything and release the doc. Idempotent. */
  destroy(): void;
}

/** How long a fresh load or a dropped connection shows "Connecting…" before it says "Offline". */
export const CONNECTING_GRACE_MS = 3500;
/** If IndexedDB hasn't answered by now (blocked, private mode), open the editor on an empty doc anyway. */
export const IDB_TIMEOUT_MS = 2500;
/** A bootstrap token closer to expiry than this is thrown away instead of being sent. */
const TOKEN_SKEW_MS = 15_000;

function emptySnapshot(): CollabSnapshot {
  return { localReady: false, contentReady: false, connection: "connecting", role: null, failure: null };
}

function sameSnapshot(a: CollabSnapshot, b: CollabSnapshot): boolean {
  return (
    a.localReady === b.localReady &&
    a.contentReady === b.contentReady &&
    a.connection === b.connection &&
    a.role === b.role &&
    a.failure?.kind === b.failure?.kind &&
    a.failure?.message === b.failure?.message
  );
}

export function createCollabSession(
  init: { pageId: string; user: CollabUserInfo },
  deps: CollabDeps,
): CollabSession {
  const pageId = init.pageId.toLowerCase();
  const documentName = `page:${pageId}`;
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT);

  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot();

  let started = false;
  let destroyed = false;

  let idb: IdbLike | null = null;
  let idbTimer: ReturnType<typeof setTimeout> | null = null;
  let localReady = false;
  let contentReady = false;

  let provider: ProviderLike | null = null;
  let wsConnected = false;
  let authenticated = false;
  let synced = false;
  let hasUnsynced = false;
  let role: EffectiveRole | null = null;
  let failure: CollabFailure | null = null;
  /** A failure retrying can't fix (no access, session over). Soft failures keep the reconnect loop going. */
  let terminal = false;
  let settled = false;

  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let wake: (() => void) | null = null;
  let bootstrapToken: CollabToken | null = null;
  let lastTokenError: unknown = null;

  const compute = (): CollabSnapshot => ({
    localReady,
    contentReady,
    connection: deriveConnection({
      failure: failure?.kind ?? null,
      online: deps.isOnline(),
      wsConnected,
      authenticated,
      synced,
      // Read-only connections never get write acks for edits made while we still had write access.
      hasUnsynced: hasUnsynced && (role === "edit" || role === "full"),
      settled,
    }),
    role,
    failure,
  });

  const notify = () => {
    if (destroyed) return;
    const next = compute();
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  /** (Re)start the grace period during which a missing connection reads as "connecting", not "offline". */
  const armGrace = () => {
    settled = false;
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      settled = true;
      notify();
    }, CONNECTING_GRACE_MS);
  };

  // ------------------------------------------------------------------------------------ local copy

  const markLocalReady = () => {
    if (destroyed || localReady) return;
    localReady = true;
    if (idbTimer) clearTimeout(idbTimer);
    idbTimer = null;
    contentReady = contentReady || fragment.length > 0;
    notify();
  };

  const startLocal = () => {
    try {
      idb = deps.createIdb(documentName, doc);
    } catch {
      // IndexedDB unavailable (blocked site data, some private modes): still editable, just not offline-capable.
      markLocalReady();
      return;
    }
    idbTimer = setTimeout(markLocalReady, IDB_TIMEOUT_MS);
    idb.whenSynced.then(markLocalReady, markLocalReady);
  };

  // ------------------------------------------------------------------------------------ connection

  const fail = (kind: CollabFailure["kind"], message: string) => {
    failure = { kind, message };
    terminal = true;
    if (provider) provider.disconnect();
    notify();
  };

  /** A failure that heals itself (a misconfigured origin that gets fixed, a flaky token endpoint). */
  const softFail = (message: string) => {
    failure = { kind: "error", message };
  };

  const clearSoftFailure = () => {
    if (!terminal && failure) failure = null;
  };

  const denyAccess = () => {
    fail("no-access", "You don't have access to this page anymore.");
    // The local copy of a page we may not read must not outlive the answer.
    const current = idb;
    idb = null;
    if (current) void Promise.resolve(current.clearData()).catch(() => undefined);
  };

  const applyToken = (token: CollabToken) => {
    role = token.role;
    notify();
  };

  /** Sleep that ends early when the browser comes back online or the session is destroyed. */
  const waitToRetry = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wake = done;
    });

  const handleTokenError = (error: unknown): "retry" | "stop" => {
    switch (classifyTokenError(error)) {
      case "no-access":
        // A page created offline isn't known to the server until its queued create is replayed.
        if (deps.hasPendingCreate(pageId)) return "retry";
        denyAccess();
        return "stop";
      case "unauthorized":
        fail("error", "Your session has expired. Sign in again to keep collaborating.");
        deps.onUnauthorized();
        return "stop";
      case "forbidden":
        fail("error", "The server refused the connection request.");
        return "stop";
      default:
        return "retry";
    }
  };

  const tokenForProvider = async (): Promise<string> => {
    lastTokenError = null;
    const cached = bootstrapToken;
    bootstrapToken = null;
    if (cached && Date.parse(cached.expiresAt) - deps.now() > TOKEN_SKEW_MS) return cached.token;
    try {
      const token = await deps.fetchToken(pageId);
      applyToken(token);
      return token.token;
    } catch (error) {
      // The provider only passes a string to `authenticationFailed`; keep the real error for classification.
      lastTokenError = error;
      throw error;
    }
  };

  const scheduleReconnect = () => {
    if (destroyed || reconnectTimer || !provider) return;
    const delay = reconnectDelay(reconnectAttempt++);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      const current = provider;
      if (!current || destroyed || terminal) return;
      // A socket that is still "connected" ignores connect(); drop it first and reopen once it is closed.
      current.disconnect();
      setTimeout(() => {
        if (!destroyed && provider === current && !terminal) void current.connect();
      }, 250);
    }, delay);
  };

  const onAuthenticationFailed = (reason: string) => {
    authenticated = false;
    const tokenError = lastTokenError;
    lastTokenError = null;

    if (tokenError !== null) {
      if (handleTokenError(tokenError) === "stop") return;
      scheduleReconnect();
      notify();
      return;
    }

    switch (classifyAuthFailure(reason)) {
      case "retry":
        scheduleReconnect();
        break;
      case "no-access":
        denyAccess();
        break;
      case "error":
        softFail("The collaboration server rejected this connection.");
        scheduleReconnect();
        break;
    }
    notify();
  };

  const attachProvider = (token: CollabToken) => {
    const created = deps.createProvider({
      url: token.wsUrl,
      name: token.documentName || documentName,
      document: doc,
      awareness,
      token: tokenForProvider,
    });
    provider = created;

    created.on("status", (payload) => {
      const status = (payload as { status?: string } | undefined)?.status;
      wsConnected = status === "connected";
      if (!wsConnected) {
        authenticated = false;
        synced = false;
        hasUnsynced = false;
        if (status === "disconnected" && !graceTimer) armGrace();
      }
      notify();
    });
    created.on("authenticated", () => {
      authenticated = true;
      reconnectAttempt = 0;
      clearSoftFailure();
      notify();
    });
    created.on("authenticationFailed", (payload) => {
      onAuthenticationFailed(String((payload as { reason?: unknown } | undefined)?.reason ?? ""));
    });
    created.on("synced", () => {
      synced = true;
      contentReady = true;
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = null;
      settled = false;
      notify();
    });
    created.on("close", () => {
      authenticated = false;
      synced = false;
      notify();
    });
    created.on("unsyncedChanges", (payload) => {
      const count = (payload as { number?: number } | undefined)?.number ?? 0;
      hasUnsynced = count > 0;
      notify();
    });
  };

  const connectLoop = async () => {
    let attempt = 0;
    while (!destroyed) {
      try {
        const token = await deps.fetchToken(pageId);
        if (destroyed) return;
        bootstrapToken = token;
        applyToken(token);
        attachProvider(token);
        return;
      } catch (error) {
        if (destroyed) return;
        if (handleTokenError(error) === "stop") return;
        notify();
        await waitToRetry(reconnectDelay(attempt++));
      }
    }
  };

  const onOnline = () => {
    wake?.();
    // Don't wait for the provider's own back-off: the network is back.
    if (provider && !wsConnected && !terminal) void provider.connect();
    notify();
  };
  const onOffline = () => notify();

  return {
    pageId,
    documentName,
    doc,
    awareness,
    fragment,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started || destroyed) return;
      started = true;
      startLocal();
      armGrace();
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
      // Deferred so a React StrictMode mount/unmount/mount (or a quick page switch) never opens a socket
      // or spends a token for a session that is torn down immediately.
      startTimer = setTimeout(() => {
        startTimer = null;
        void connectLoop();
      }, 0);
      notify();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const timer of [startTimer, graceTimer, reconnectTimer, idbTimer]) if (timer) clearTimeout(timer);
      wake?.();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      listeners.clear();
      const currentProvider = provider;
      const currentIdb = idb;
      provider = null;
      idb = null;
      // One task later, so the editor bound to this doc (a child component) has been unmounted first.
      setTimeout(() => {
        if (currentProvider) currentProvider.destroy();
        else awareness.destroy();
        void Promise.resolve(currentIdb?.destroy()).catch(() => undefined);
        doc.destroy();
      }, 0);
    },
  };
}

// ---------------------------------------------------------------------------------------------------

export interface BrowserDepsOptions {
  hasPendingCreate: (pageId: string) => boolean;
  onUnauthorized: () => void;
}

/** Real IndexedDB + Hocuspocus. */
export function createBrowserDeps(options: BrowserDepsOptions): CollabDeps {
  return {
    createIdb(name, doc) {
      const persistence = new IndexeddbPersistence(name, doc);
      // y-indexeddb leaves a rejected open() unhandled; the whenSynced timeout in the session covers the UX.
      // `_db` is its (undocumented) open promise.
      (persistence as unknown as { _db?: Promise<unknown> })._db?.catch(() => undefined);
      return persistence;
    },
    createProvider({ url, name, document, awareness, token }) {
      return new HocuspocusProvider({
        url,
        name,
        document,
        awareness,
        token,
      });
    },
    fetchToken: (pageId) => fetchCollabToken(pageId),
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    now: () => Date.now(),
    hasPendingCreate: options.hasPendingCreate,
    onUnauthorized: options.onUnauthorized,
  };
}
