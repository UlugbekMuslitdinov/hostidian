"use client";

import { AppLink } from "@/lib/nav";
import { pageHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { GraphNode } from "./graph-model";

const MAX_LISTED = 500;

/**
 * The graph as a plain list of links. The canvas is invisible to keyboards and screen readers, so this is the
 * accessible way to reach the same pages; it is visually hidden.
 */
export function GraphNodeList({ nodes }: { nodes: readonly GraphNode[] }) {
  const { workspace } = useWorkspace();
  return (
    <ul className="sr-only" aria-label="Pages in the graph">
      {nodes.slice(0, MAX_LISTED).map((node) => (
        <li key={node.id}>
          <AppLink href={pageHref(workspace.slug, node.id)}>
            {node.title} ({node.degree} {node.degree === 1 ? "link" : "links"})
          </AppLink>
        </li>
      ))}
    </ul>
  );
}
