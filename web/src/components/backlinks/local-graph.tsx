"use client";

import { ChevronRight, Network } from "lucide-react";
import { useState } from "react";
import { DepthPicker } from "@/components/graph/depth-picker";
import { ForceGraphCanvas } from "@/components/graph/force-graph";
import { useGraph } from "@/components/graph/use-graph";
import { useAppNavigate, AppLink } from "@/lib/nav";
import { cn, pageHref, workspaceHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/**
 * "Local graph" under the page: the page and the pages within a few links of it, drawn like the workspace graph.
 * Collapsed by default so a page view never pays for the graph request or the canvas unless asked.
 */
export function LocalGraphSection({ pageId }: { pageId: string }) {
  const { workspace } = useWorkspace();
  const navigate = useAppNavigate();
  const [open, setOpen] = useState(false);
  const [depth, setDepth] = useState(1);
  const { query, model, match } = useGraph(workspace.id, "", { enabled: open, local: { centerId: pageId, depth } });

  return (
    <section aria-label="Local graph">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
          <Network className="size-3.5" aria-hidden="true" />
          Local graph
        </button>
        {open ? (
          <>
            <DepthPicker depth={depth} onChange={setDepth} />
            <AppLink
              href={`${workspaceHref(workspace.slug)}/graph?focus=${pageId}`}
              className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Open full graph
            </AppLink>
          </>
        ) : null}
      </div>

      {open ? (
        <div className="relative mt-2 h-72 overflow-hidden rounded-lg border bg-muted/20" data-testid="local-graph">
          {query.isPending ? (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">Loading…</p>
          ) : query.isError ? (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">Couldn&apos;t load the graph.</p>
          ) : model.nodes.length === 0 ? (
            <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">Nothing to show for this page yet.</p>
          ) : (
            <>
              <ForceGraphCanvas
                nodes={model.nodes}
                links={model.links}
                matched={match.matched}
                centerId={pageId}
                onSelect={(id) => {
                  if (id !== pageId) navigate(pageHref(workspace.slug, id));
                }}
              />
              {model.links.length === 0 ? (
                <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-muted-foreground">
                  This page has no links yet.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
