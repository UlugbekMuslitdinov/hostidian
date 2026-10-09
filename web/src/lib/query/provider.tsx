"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createQueryClient } from "./client";
import { setupMutationDefaults } from "./mutations";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const qc = createQueryClient();
    // Must be registered before any mutation is created *or restored* from storage.
    setupMutationDefaults(qc);
    return qc;
  });

  // ---------------------------------------------------------------------------------------------
  // WAVE 2 SEAM (pwa-offline): offline persistence plugs in right here. Replace <QueryClientProvider>
  // with TanStack's <PersistQueryClientProvider client={client} persistOptions={{ persister, maxAge:
  // CACHE_MAX_AGE_MS, buster }} onSuccess={() => client.resumePausedMutations()}>, where `persister`
  // is an idb-keyval based async persister (src/lib/offline). Paused mutations (createPage, renamePage,
  // movePage, ...) rehydrate and resume because their mutationFn/optimistic handlers live in
  // setupMutationDefaults() above, keyed by mutationKey. Also register logout cleanup via
  // registerLogoutCleanup() (src/lib/session-cleanup.ts) to wipe the persisted cache.
  // ---------------------------------------------------------------------------------------------
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
