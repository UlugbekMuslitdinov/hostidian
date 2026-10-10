import type { QueryClient } from "@tanstack/react-query";
import { hasPendingCreate } from "../collab/pending";
import { connectivityStore } from "./connectivity-store";
import { pageDbName } from "./keys";
import { createStore } from "./store";
import {
  browserHasDatabase,
  browserIsConstrained,
  browserWhenIdle,
  createPrefetcher,
  readPrefetchRecords,
  writePrefetchRecords,
  type Prefetcher,
} from "./prefetch";
import { syncPageDocument } from "./prefetch-sync";

/** Id (lower-cased) of the page whose editor is open, or null. The editor keeps that document current itself. */
export const openPageStore = createStore<string | null>(null);

/** The prefetcher wired to the real browser: connectivity, IndexedDB, Hocuspocus, localStorage bookkeeping. */
export function createBrowserPrefetcher(queryClient: QueryClient, userId: string): Prefetcher {
  return createPrefetcher({
    now: () => Date.now(),
    isOnline: () => connectivityStore.get().online && navigator.onLine !== false,
    isConstrained: browserIsConstrained,
    isOpen: (pageId) => openPageStore.get() === pageId.toLowerCase(),
    isLocalOnly: (pageId) => hasPendingCreate(queryClient, pageId),
    hasLocalCopy: (pageId) => browserHasDatabase(pageDbName(pageId.toLowerCase())),
    syncPage: (pageId, signal) => syncPageDocument(pageId, signal),
    loadRecords: () => readPrefetchRecords(userId),
    saveRecords: (records) => writePrefetchRecords(userId, records),
    whenIdle: browserWhenIdle,
  });
}
