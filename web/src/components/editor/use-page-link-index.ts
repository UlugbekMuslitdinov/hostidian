"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { PageLinkInfo } from "@hostidian/editor-schema/react";
import { pagesOptions } from "@/lib/api/queries";

/**
 * id → {current title, icon} for the page-link chips, built from the cached page tree so a chip always
 * shows the target's *current* title and works offline. Unknown ids (deleted, no access, not yet loaded)
 * are simply absent, and `pageLinkSpec` then falls back to the title stored in the node.
 */
export function usePageLinkIndex(workspaceId: string): Map<string, PageLinkInfo> {
  const query = useQuery(pagesOptions(workspaceId));
  return useMemo(() => {
    const index = new Map<string, PageLinkInfo>();
    for (const page of query.data ?? []) {
      if (page.archivedAt) continue;
      index.set(page.id.toLowerCase(), { title: page.title, icon: page.icon ?? null });
    }
    return index;
  }, [query.data]);
}
