import type { MutationCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import { errorMessage, hasStatus } from "../api/error";
import { createStore, type ExternalStore } from "./store";

/**
 * What the connectivity indicator and the offline banner show, derived from three facts: is the server
 * reachable, how many queued tree mutations still wait to be replayed, and did a replay fail for good.
 */

export type SyncKind = "online" | "offline" | "syncing" | "error";

export interface SyncError {
  title: string;
  message: string;
  at: number;
}

export interface SyncSnapshot {
  /** Mutations that have not reached the server yet (running, retrying or queued while offline). */
  pending: number;
  /** The last mutation that failed for good (rolled back); cleared by "Retry" / dismissing. */
  error: SyncError | null;
}

export function deriveSyncKind(input: { online: boolean; pending: number; error: SyncError | null }): SyncKind {
  if (!input.online) return "offline";
  if (input.error) return "error";
  return input.pending > 0 ? "syncing" : "online";
}

export interface SyncMonitor {
  readonly store: ExternalStore<SyncSnapshot>;
  clearError(): void;
  dispose(): void;
}

export function countPendingMutations(queryClient: QueryClient): number {
  return queryClient
    .getMutationCache()
    .getAll()
    .filter((m) => m.state.status === "pending").length;
}

/** Watches the mutation cache. Cheap: one pass over a handful of mutations per cache event. */
export function createSyncMonitor(queryClient: QueryClient, now: () => number = Date.now): SyncMonitor {
  const cache = queryClient.getMutationCache();
  const store = createStore<SyncSnapshot>({ pending: countPendingMutations(queryClient), error: null });

  const onEvent = (event: MutationCacheNotifyEvent) => {
    const pending = countPendingMutations(queryClient);
    let { error } = store.get();
    if (event.type === "updated" && event.action.type === "error") {
      const failure: unknown = event.action.error;
      // A 401 means "signed out", which the auth gate handles; it is not a sync problem.
      if (!hasStatus(failure, 401)) {
        const title = event.mutation.meta?.errorTitle;
        error = {
          title: typeof title === "string" ? title : "A change couldn't be saved",
          message: errorMessage(failure),
          at: now(),
        };
      }
    }
    store.set(pending === store.get().pending && error === store.get().error ? store.get() : { pending, error });
  };

  const unsubscribe = cache.subscribe(onEvent);
  return {
    store,
    clearError: () => store.update((s) => (s.error ? { ...s, error: null } : s)),
    dispose: unsubscribe,
  };
}
