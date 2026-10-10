"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { favoritesOptions, pagesOptions } from "@/lib/api/queries";
import { useOnline } from "@/lib/offline/context";
import { selectPrefetchTargets } from "@/lib/offline/prefetch";
import { createBrowserPrefetcher, openPageStore } from "@/lib/offline/prefetch-browser";
import { useRoute } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";

/** First pass waits for the page to settle, so the prefetch never competes with what the user is loading. */
export const FIRST_PASS_DELAY_MS = 4_000;
/** Later passes (tree changed, connection came back) are coalesced. */
export const NEXT_PASS_DELAY_MS = 20_000;
/**
 * A page that keeps changing is re-synced at most every MIN_RESYNC_MS, so the pass triggered by its last change can
 * land inside that window and skip it. This tick makes sure such pages are picked up shortly after the window ends.
 */
export const REFRESH_TICK_MS = 2 * 60 * 1000 + 5_000;

/**
 * Drives the page prefetcher: whenever the app is online and the tree is loaded it syncs the documents of the
 * recent and favorite pages into IndexedDB (same `page:<id>` databases the editor uses), so they open offline.
 * Starts after sign-in (this component only mounts inside the authenticated shell), restarts when the
 * connection returns and when the tree changes. Renders nothing.
 */
export function OfflineSync() {
  const qc = useQueryClient();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const route = useRoute();
  const online = useOnline();
  const pages = useQuery(pagesOptions(workspace.id));
  const favorites = useQuery(favoritesOptions(workspace.id));

  const openPageId = route.kind === "page" ? route.pageId.toLowerCase() : null;
  useEffect(() => {
    openPageStore.set(openPageId);
    return () => openPageStore.set(null);
  }, [openPageId]);

  const userId = user.id;
  const prefetcher = useMemo(() => createBrowserPrefetcher(qc, userId), [qc, userId]);
  useEffect(() => () => prefetcher.stop(), [prefetcher]);

  // The page that just opened has its own live session now.
  useEffect(() => {
    if (openPageId) prefetcher.cancelPage(openPageId);
  }, [openPageId, prefetcher]);

  const targets = useMemo(
    () => selectPrefetchTargets({ pages: pages.data ?? [], favorites: favorites.data ?? [] }),
    [pages.data, favorites.data],
  );
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  });
  // What the schedule depends on: which pages, and whether they changed on the server.
  const signature = targets.map((t) => `${t.id}@${t.updatedAt}`).join("|");

  const ready = online && pages.data !== undefined && !pages.isFetching;
  const passes = useRef(0);
  useEffect(() => {
    if (!ready || signature === "") return;
    const timer = window.setTimeout(
      () => {
        passes.current += 1;
        void prefetcher.run(targetsRef.current);
      },
      passes.current === 0 ? FIRST_PASS_DELAY_MS : NEXT_PASS_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [ready, signature, prefetcher]);

  useEffect(() => {
    if (!ready) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && targetsRef.current.length > 0) void prefetcher.run(targetsRef.current);
    }, REFRESH_TICK_MS);
    return () => window.clearInterval(tick);
  }, [ready, prefetcher]);

  return null;
}
