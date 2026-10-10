import { readJSON, writeJSON } from "../storage";
import { OFFLINE_KEYS } from "./keys";

/**
 * Keeps the documents of the pages a user is most likely to open on the device, so they open offline.
 *
 * When the app is online and idle, the ~20 most recently updated pages plus the favorites are synced into
 * IndexedDB (lib/offline/prefetch-sync.ts), two at a time. The scheduler here is pure: everything that touches
 * the browser (network state, "is this page open", the actual sync, localStorage bookkeeping, idle time) comes in
 * through {@link PrefetchDeps}, so the rules are unit-tested with fakes.
 *
 * Rules:
 *  - never when offline, on a Save-Data / 2G connection, or when storage is nearly full;
 *  - never for the page whose editor is open (its own session keeps that document current), and a page that gets
 *    opened while it is being synced is cancelled;
 *  - never for pages created offline that the server has not seen yet;
 *  - a page is only re-synced when it changed on the server since the last sync (or the copy is a day old),
 *    and not more often than every {@link MIN_RESYNC_MS};
 *  - a page that failed is not retried for {@link RETRY_AFTER_MS}.
 */

export const PREFETCH_CONCURRENCY = 2;
export const PREFETCH_RECENT_COUNT = 20;
export const PREFETCH_FAVORITE_COUNT = 10;
/** A synced copy older than this is refreshed even if the page did not change (cheap insurance). */
export const PREFETCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Upper bound on how often one page is re-synced while it keeps changing (someone else is editing it). */
export const MIN_RESYNC_MS = 2 * 60 * 1000;
export const RETRY_AFTER_MS = 10 * 60 * 1000;

export interface PrefetchCandidate {
  id: string;
  /** RFC 3339, from the page tree. */
  updatedAt: string;
  archivedAt?: string | null;
}

/**
 * Which pages to keep offline: the most recently updated ones first, then favorites that are not among them.
 * Archived pages are never included.
 */
export function selectPrefetchTargets(
  input: { pages: readonly PrefetchCandidate[]; favorites: readonly PrefetchCandidate[] },
  limits: { recent?: number; favorites?: number } = {},
): PrefetchCandidate[] {
  const recentLimit = limits.recent ?? PREFETCH_RECENT_COUNT;
  const favoriteLimit = limits.favorites ?? PREFETCH_FAVORITE_COUNT;
  const live = (p: PrefetchCandidate) => !p.archivedAt;

  const recent = input.pages
    .filter(live)
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, recentLimit);

  const seen = new Set(recent.map((p) => p.id));
  const favorites: PrefetchCandidate[] = [];
  for (const page of input.favorites) {
    if (favorites.length >= favoriteLimit) break;
    if (live(page) && !seen.has(page.id)) {
      seen.add(page.id);
      favorites.push(page);
    }
  }
  return [...recent, ...favorites];
}

/** Does the copy on this device (synced at `syncedAt`) need refreshing? Pure. */
export function needsSync(page: PrefetchCandidate, syncedAt: number | undefined, now: number): boolean {
  if (syncedAt === undefined) return true;
  const age = now - syncedAt;
  if (age < MIN_RESYNC_MS) return false;
  if (age > PREFETCH_MAX_AGE_MS) return true;
  const updated = Date.parse(page.updatedAt);
  return Number.isFinite(updated) && updated > syncedAt;
}

export interface PrefetchDeps {
  now(): number;
  /** Effective connectivity (browser online and the server reachable). */
  isOnline(): boolean;
  /** Save-Data header / slow connection / low storage: do not spend the user's resources. */
  isConstrained(): boolean | Promise<boolean>;
  /** The editor of this page is open right now. */
  isOpen(pageId: string): boolean;
  /** Created on this device and not yet known to the server. */
  isLocalOnly(pageId: string): boolean;
  /** Does IndexedDB still hold the page's database? Optional; without it the bookkeeping is trusted. */
  hasLocalCopy?(pageId: string): Promise<boolean>;
  /** Download the page's document into IndexedDB. Rejects on failure; must honour `signal`. */
  syncPage(pageId: string, signal: AbortSignal): Promise<void>;
  /** page id -> when the last successful sync finished (ms since epoch). */
  loadRecords(): Record<string, number>;
  saveRecords(records: Record<string, number>): void;
  /** Run `fn` when the browser is idle; returns a canceller. */
  whenIdle(fn: () => void): () => void;
}

export interface PrefetchResult {
  synced: string[];
  failed: string[];
  /** Pages that did not need a sync or were not eligible. */
  skipped: number;
  /** The pass ended early (offline, constrained, stopped). */
  interrupted: boolean;
}

export interface Prefetcher {
  /** Sync what needs syncing. Overlapping calls are coalesced: the latest candidate list runs after the current pass. */
  run(candidates: readonly PrefetchCandidate[]): Promise<PrefetchResult>;
  /** The page was opened: abort its sync if one is running. */
  cancelPage(pageId: string): void;
  /** Abort everything and refuse further passes. */
  stop(): void;
}

export function createPrefetcher(
  deps: PrefetchDeps,
  options: { concurrency?: number; retryAfterMs?: number } = {},
): Prefetcher {
  const concurrency = Math.max(1, options.concurrency ?? PREFETCH_CONCURRENCY);
  const retryAfter = options.retryAfterMs ?? RETRY_AFTER_MS;

  let stopped = false;
  let running: Promise<PrefetchResult> | null = null;
  let queued: readonly PrefetchCandidate[] | null = null;
  const inFlight = new Map<string, AbortController>();
  const failedAt = new Map<string, number>();

  const eligible = (page: PrefetchCandidate) =>
    !deps.isOpen(page.id) && !deps.isLocalOnly(page.id) && !inFlight.has(page.id);

  const idle = () =>
    new Promise<void>((resolve) => {
      deps.whenIdle(resolve);
    });

  async function pass(candidates: readonly PrefetchCandidate[]): Promise<PrefetchResult> {
    const result: PrefetchResult = { synced: [], failed: [], skipped: 0, interrupted: false };
    const records = deps.loadRecords();

    // Decide who is due up front; the cheap, synchronous checks first.
    const due: PrefetchCandidate[] = [];
    for (const page of candidates) {
      const failed = failedAt.get(page.id);
      if (!eligible(page) || (failed !== undefined && deps.now() - failed < retryAfter)) {
        result.skipped += 1;
        continue;
      }
      if (needsSync(page, records[page.id], deps.now())) {
        due.push(page);
        continue;
      }
      if (deps.hasLocalCopy && !(await deps.hasLocalCopy(page.id))) {
        due.push(page); // the browser evicted the database; the bookkeeping is stale
        continue;
      }
      result.skipped += 1;
    }

    const queue = [...due];
    const worker = async () => {
      for (;;) {
        await idle();
        if (stopped || !deps.isOnline() || (await deps.isConstrained())) {
          result.interrupted = true;
          return;
        }
        const page = queue.shift();
        if (!page) return;
        // Re-check at the moment of the sync: the user may have opened the page while it waited in the queue.
        if (!eligible(page)) {
          result.skipped += 1;
          continue;
        }
        const controller = new AbortController();
        inFlight.set(page.id, controller);
        try {
          await deps.syncPage(page.id, controller.signal);
          const synced = Math.max(deps.now(), Date.parse(page.updatedAt) || 0);
          records[page.id] = synced;
          deps.saveRecords({ ...records });
          result.synced.push(page.id);
        } catch {
          if (!controller.signal.aborted) {
            failedAt.set(page.id, deps.now());
            result.failed.push(page.id);
          }
        } finally {
          inFlight.delete(page.id);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return result;
  }

  async function drain(first: readonly PrefetchCandidate[]): Promise<PrefetchResult> {
    let result = await pass(first);
    // A call that arrived mid-pass wins over the one that just finished; merge the counters into one report.
    while (queued && !stopped) {
      const next: readonly PrefetchCandidate[] = queued;
      queued = null;
      const more = await pass(next);
      result = {
        synced: [...result.synced, ...more.synced],
        failed: [...result.failed, ...more.failed],
        skipped: more.skipped,
        interrupted: more.interrupted,
      };
    }
    return result;
  }

  return {
    run(candidates) {
      if (stopped) return Promise.resolve({ synced: [], failed: [], skipped: candidates.length, interrupted: true });
      if (running) {
        queued = candidates;
        return running;
      }
      const current = drain(candidates).finally(() => {
        if (running === current) running = null;
      });
      running = current;
      return current;
    },
    cancelPage(pageId) {
      inFlight.get(pageId)?.abort();
    },
    stop() {
      stopped = true;
      queued = null;
      for (const controller of inFlight.values()) controller.abort();
    },
  };
}

// ----------------------------------------------------------------------------------------------------------
// Browser bindings
// ----------------------------------------------------------------------------------------------------------

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** Fraction of the storage quota above which nothing more is downloaded. */
const STORAGE_PRESSURE = 0.8;

export async function browserIsConstrained(): Promise<boolean> {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (connection?.saveData) return true;
  if (connection?.effectiveType && /(?:^|-)2g$/.test(connection.effectiveType)) return true;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.usage !== undefined && estimate.usage / estimate.quota > STORAGE_PRESSURE) return true;
  } catch {
    // no estimate available: assume there is room
  }
  return false;
}

export function browserWhenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(fn, { timeout: 4_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(fn, 250);
  return () => window.clearTimeout(handle);
}

/** Does IndexedDB list a database of that name? `true` when the browser cannot tell (then the bookkeeping rules). */
export async function browserHasDatabase(name: string): Promise<boolean> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return true;
  try {
    return (await indexedDB.databases()).some((db) => db.name === name);
  } catch {
    return true;
  }
}

/** Per-user bookkeeping in localStorage (wiped by clearOfflineData together with the documents it describes). */
export function readPrefetchRecords(userId: string): Record<string, number> {
  const raw = readJSON<unknown>(OFFLINE_KEYS.prefetch(userId), {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const records: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw)) if (typeof value === "number" && Number.isFinite(value)) records[id] = value;
  return records;
}

export function writePrefetchRecords(userId: string, records: Record<string, number>): void {
  writeJSON(OFFLINE_KEYS.prefetch(userId), records);
}
