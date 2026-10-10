"use client";

import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useEffect, useState, type ReactNode } from "react";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import { OfflineRuntimeProvider } from "@/lib/offline/context";
import { createOfflineRuntime } from "@/lib/offline/runtime";

/**
 * The query client with offline persistence (see lib/offline/runtime.ts for the wiring):
 *
 *  - the cache and the queue of unsent mutations are restored from IndexedDB before queries run
 *    (`PersistQueryClientProvider` keeps them paused while restoring), under the signed-in user's namespace;
 *  - once restored, queued mutations are replayed (`resumePausedMutations`), and again whenever the connectivity
 *    monitor reports the server reachable;
 *  - the PWA runtime (service worker, install prompt, theme color) lives below it so it shares the toaster.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [runtime] = useState(() => createOfflineRuntime());
  useEffect(() => runtime.start(), [runtime]);

  return (
    <OfflineRuntimeProvider runtime={runtime}>
      <PersistQueryClientProvider
        client={runtime.queryClient}
        persistOptions={runtime.persistOptions}
        onSuccess={() => void runtime.queryClient.resumePausedMutations()}
      >
        <PwaProvider>{children}</PwaProvider>
      </PersistQueryClientProvider>
    </OfflineRuntimeProvider>
  );
}
