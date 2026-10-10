import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage, hasStatus, isTransientError } from "../api/error";
import { qk } from "../api/keys";

/**
 * How long unused queries stay in memory. TanStack requires this to be >= the persisted cache's `maxAge`
 * (lib/offline/persister.ts PERSIST_MAX_AGE_MS), otherwise restored queries would be garbage-collected right
 * after they are restored (a test keeps the two in step).
 */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Retry transport failures and 5xx gateway blips a couple of times; never retry 4xx. */
function retryQuery(failureCount: number, error: unknown): boolean {
  if (hasStatus(error, 401, 403, 404)) return false;
  return isTransientError(error) && failureCount < 2;
}

function retryMutation(failureCount: number, error: unknown): boolean {
  // While offline TanStack pauses between attempts and resumes when the browser is back online.
  return isTransientError(error) && failureCount < 5;
}

function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

/** Session expired mid-use: drop the cached identity so the (app) gate redirects to /login. */
function handleAuthError(
  client: QueryClient,
  error: unknown,
  queryKey: readonly unknown[] | undefined,
  meta: Record<string, unknown> | undefined,
) {
  if (!hasStatus(error, 401) || meta?.skipAuthRedirect) return;
  // `/auth/me` answering 401 is the normal "signed out" signal, handled by the gate itself.
  if (queryKey && JSON.stringify(queryKey) === JSON.stringify(qk.me())) return;
  void client.invalidateQueries({ queryKey: qk.me() });
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => handleAuthError(client, error, query.queryKey, query.meta),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        handleAuthError(client, error, undefined, mutation.meta);
        // Mutations opt in to a toast through `meta.errorTitle` (their optimistic change was rolled back).
        const title = mutation.meta?.errorTitle;
        if (typeof title === "string" && !hasStatus(error, 401)) {
          toast.error(title, { description: errorMessage(error) });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: CACHE_MAX_AGE_MS,
        retry: retryQuery,
        retryDelay,
        refetchOnWindowFocus: true,
        // networkMode `online` (default): offline queries pause and keep showing cached data.
      },
      mutations: {
        // Attempt immediately even when navigator.onLine is wrong, then pause retries until online.
        networkMode: "offlineFirst",
        retry: retryMutation,
        retryDelay,
      },
    },
  });
  return client;
}
