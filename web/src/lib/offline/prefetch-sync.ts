import { HocuspocusProvider } from "@hocuspocus/provider";
import type { CollabToken } from "@hostidian/api-types";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { fetchCollabToken } from "../collab/token";
import { pageDbName } from "./keys";

/**
 * Downloads one page's document into IndexedDB without opening an editor: a headless Y.Doc backed by the same
 * `IndexeddbPersistence('page:<pageId>')` database the editor uses, filled by a short-lived Hocuspocus
 * connection. Opening that page later (offline) finds the content on the device.
 *
 * Dependency-injected like lib/collab/session.ts so the sequencing is testable without sockets or IndexedDB.
 */

/** Give up on a page that has not finished syncing after this long (slow link, overloaded server). */
export const PAGE_SYNC_TIMEOUT_MS = 25_000;

export interface PrefetchProvider {
  on(event: string, handler: (payload: unknown) => void): unknown;
  destroy(): void;
  readonly synced: boolean;
  /** Local updates the server has not acknowledged yet. */
  readonly unsyncedChanges: number;
}

export interface PrefetchIdb {
  whenSynced: Promise<unknown>;
  destroy(): Promise<unknown> | void;
}

export interface PageSyncDeps {
  fetchToken(pageId: string, signal: AbortSignal): Promise<CollabToken>;
  createIdb(name: string, doc: Y.Doc): PrefetchIdb;
  createProvider(config: {
    url: string;
    name: string;
    document: Y.Doc;
    awareness: Awareness;
    token: string;
  }): PrefetchProvider;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class PageSyncError extends Error {
  readonly reason: "auth" | "timeout" | "aborted";
  constructor(reason: PageSyncError["reason"], message: string) {
    super(message);
    this.name = "PageSyncError";
    this.reason = reason;
  }
}

export const browserPageSyncDeps: PageSyncDeps = {
  fetchToken: (pageId, signal) => fetchCollabToken(pageId, signal),
  createIdb(name, doc) {
    const persistence = new IndexeddbPersistence(name, doc);
    // y-indexeddb leaves a rejected open() unhandled (private mode, blocked site data); the caller sees it as a
    // failed sync through `whenSynced`/the timeout instead of an unhandled rejection. `_db` is its open promise.
    (persistence as unknown as { _db?: Promise<unknown> })._db?.catch(() => undefined);
    return persistence;
  },
  createProvider: ({ url, name, document, awareness, token }) =>
    new HocuspocusProvider({ url, name, document, awareness, token }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** After the initial sync, wait at most this long for edits made offline earlier to be acknowledged by the server. */
export const FLUSH_LOCAL_CHANGES_MS = 5_000;

/**
 * Resolves once the server state of the page is stored on this device (and any edits that were waiting on this
 * device have been sent). Rejects with a {@link PageSyncError} (timeout, access refused, aborted) or the token
 * request's error. Always releases the doc, socket and IndexedDB handle.
 */
export async function syncPageDocument(
  pageId: string,
  signal: AbortSignal,
  deps: PageSyncDeps = browserPageSyncDeps,
  timeoutMs: number = PAGE_SYNC_TIMEOUT_MS,
): Promise<void> {
  if (signal.aborted) throw new PageSyncError("aborted", "Sync was cancelled");
  const token = await deps.fetchToken(pageId, signal);
  if (signal.aborted) throw new PageSyncError("aborted", "Sync was cancelled");

  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // Not a participant: a headless sync must never show up in the presence stack of the page's editors.
  awareness.setLocalState(null);
  // Same casing as the editor's session (lib/collab/session.ts), otherwise the editor would not find this database.
  const idb = deps.createIdb(pageDbName(pageId.toLowerCase()), doc);
  const handles: { provider: PrefetchProvider | null; timers: unknown[]; onAbort: (() => void) | null } = {
    provider: null,
    timers: [],
    onAbort: null,
  };

  try {
    await idb.whenSynced;
    await new Promise<void>((resolve, reject) => {
      const provider = deps.createProvider({
        url: token.wsUrl,
        name: token.documentName,
        document: doc,
        awareness,
        token: token.token,
      });
      handles.provider = provider;
      handles.timers.push(
        deps.setTimeout(() => reject(new PageSyncError("timeout", "Timed out syncing the page")), timeoutMs),
      );
      handles.onAbort = () => reject(new PageSyncError("aborted", "Sync was cancelled"));
      signal.addEventListener("abort", handles.onAbort, { once: true });

      provider.on("authenticationFailed", () => reject(new PageSyncError("auth", "The server refused the connection")));
      provider.on("synced", () => {
        if (provider.unsyncedChanges === 0) {
          resolve();
          return;
        }
        // Edits made offline in an earlier session are still on this device: let them reach the server first.
        handles.timers.push(deps.setTimeout(resolve, FLUSH_LOCAL_CHANGES_MS));
        provider.on("unsyncedChanges", (payload) => {
          if (((payload as { number?: number } | undefined)?.number ?? 0) === 0) resolve();
        });
      });
    });
  } finally {
    for (const timer of handles.timers) deps.clearTimeout(timer);
    if (handles.onAbort) signal.removeEventListener("abort", handles.onAbort);
    // Stop the socket first (no more incoming updates), then close IndexedDB: y-indexeddb's pending write
    // transactions complete even though its connection is closed right after.
    if (handles.provider) handles.provider.destroy();
    else awareness.destroy();
    await Promise.resolve(idb.destroy()).catch(() => undefined);
    doc.destroy();
  }
}
