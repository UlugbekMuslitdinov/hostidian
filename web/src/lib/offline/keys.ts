import { STORAGE_KEYS } from "@/lib/storage";

/** localStorage keys owned by the offline layer (the rest live in lib/storage.ts). */
export const OFFLINE_KEYS = {
  /** Id of the user whose data is cached on this device; selects the persisted-cache namespace. */
  lastUser: "hostidian:lastUser",
  /** When the install card was last dismissed (ms since epoch). */
  installDismissedAt: "hostidian:installDismissedAt",
  /** Last-synced bookkeeping of the page prefetcher, per user. */
  prefetch: (userId: string) => `hostidian:prefetch:${userId}`,
} as const;

/** Prefix of every localStorage key this app writes. */
export const APP_STORAGE_PREFIX = "hostidian:";

/**
 * localStorage entries that describe the device, not the signed-in user, and therefore survive logout /
 * user change. Everything else under `hostidian:` is wiped (tree state, recents, prefetch bookkeeping, ...).
 */
export const DEVICE_STORAGE_KEYS: ReadonlySet<string> = new Set([
  STORAGE_KEYS.sidebarOpen,
  OFFLINE_KEYS.installDismissedAt,
]);

/** y-indexeddb database name of a page document (contract with the editor: `page:<pageId>`). */
export const PAGE_DB_PREFIX = "page:";
export const pageDbName = (pageId: string) => `${PAGE_DB_PREFIX}${pageId}`;
