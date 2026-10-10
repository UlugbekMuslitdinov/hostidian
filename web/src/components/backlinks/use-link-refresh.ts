"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { onWorkspaceEvent } from "@/lib/events/bus";
import { qk } from "@/lib/api/keys";

/**
 * Events after which links between pages (and so backlinks and the graph) may have changed. The collab server
 * emits a plain `page.updated` after it has extracted the links of an edited page, which is the one that matters.
 */
const LINK_EVENTS: ReadonlySet<string> = new Set([
  "page.updated",
  "page.created",
  "page.archived",
  "page.restored",
  "page.deleted",
  "permissions.changed",
]);

export const affectsLinks = (eventType: string): boolean => LINK_EVENTS.has(eventType);

export const LINK_REFRESH_DELAY_MS = 800;

/**
 * Keeps the cached backlinks and graph fresh while the user is looking at them. They are plain queries with a
 * stale time, so without this a link someone else just added would only show after the cache expires.
 */
export function useLinkRefresh(workspaceId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      void qc.invalidateQueries({ queryKey: qk.graph(workspaceId) });
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] === "page" && query.queryKey[2] === "backlinks" });
    };
    const off = onWorkspaceEvent((event) => {
      if (event.workspaceId !== workspaceId || !affectsLinks(event.type)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, LINK_REFRESH_DELAY_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [qc, workspaceId]);
}
