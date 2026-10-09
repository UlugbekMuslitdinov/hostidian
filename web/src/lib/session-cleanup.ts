/**
 * Hooks that run when the user logs out (or the session is revoked). Wave 2 registers the offline
 * cache wipe here (persisted TanStack cache in IndexedDB, y-indexeddb databases, service-worker caches).
 */
type Cleanup = () => void | Promise<void>;

const cleanups = new Set<Cleanup>();

export function registerLogoutCleanup(fn: Cleanup): () => void {
  cleanups.add(fn);
  return () => {
    cleanups.delete(fn);
  };
}

export async function runLogoutCleanups(): Promise<void> {
  await Promise.allSettled([...cleanups].map((fn) => fn()));
}
