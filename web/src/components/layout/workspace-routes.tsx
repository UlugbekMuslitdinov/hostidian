"use client";

import { useEffect } from "react";
import { GraphView } from "@/components/graph/graph-view";
import { PageView } from "@/components/page/page-view";
import { TrashView } from "@/components/page/trash-view";
import { WorkspaceHome } from "@/components/page/workspace-home";
import { useRoute } from "@/lib/nav";

/**
 * The single client-side "router" behind every /w/[slug]/** route file (home, page, trash). Because the
 * route files all render this same component, moving between them with shallow navigation (see lib/nav.tsx)
 * never needs the server — which is what makes opening pages work offline.
 *
 * WAVE 2: add new in-workspace views here (e.g. a graph view) rather than as separate route files, so
 * they stay reachable offline. Replace PageView's body, not this switch, when wiring the editor.
 */
export function WorkspaceRoutes() {
  const route = useRoute();
  const viewKey = route.kind === "page" ? `page:${route.pageId}` : route.kind;

  // Shallow navigation doesn't reset scroll; the scroll container is <main>, not the window.
  useEffect(() => {
    document.getElementById("main")?.scrollTo({ top: 0 });
  }, [viewKey]);

  switch (route.kind) {
    case "page":
      return <PageView key={route.pageId} pageId={route.pageId} />;
    case "trash":
      return <TrashView />;
    case "graph":
      return <GraphView />;
    default:
      return <WorkspaceHome />;
  }
}
