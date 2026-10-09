"use client";

import { Network, Search } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { TopBar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAppNavigate } from "@/lib/nav";
import { pageHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { ForceGraphCanvas } from "./force-graph";
import { useGraph } from "./use-graph";

/** Interactive link graph for the current workspace: pages as nodes, wikilinks as edges. */
export function GraphView() {
  const { workspace } = useWorkspace();
  const navigate = useAppNavigate();
  const [filter, setFilter] = useState("");
  useDocumentTitle("Graph");

  const { query, model, match } = useGraph(workspace.id, filter);
  const hasPages = (query.data?.nodes.length ?? 0) > 0;
  const filtering = filter.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar>
        <span className="truncate px-1.5 text-[13px] font-medium">Graph</span>
      </TopBar>

      {query.isPending ? (
        <GraphSkeleton />
      ) : query.isError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={Network}
            title="Couldn't load the graph"
            description="Check your connection and try again."
            action={<Button onClick={() => void query.refetch()}>Try again</Button>}
          />
        </div>
      ) : !hasPages ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={Network}
            title="Nothing to graph yet"
            description="Create some pages and link them with [[ ]] — their connections will show up here."
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter pages…"
                aria-label="Filter graph pages by title"
                className="pl-8"
              />
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {filtering
                ? `${match.count} of ${model.nodes.length} ${model.nodes.length === 1 ? "page" : "pages"}`
                : `${model.nodes.length} ${model.nodes.length === 1 ? "page" : "pages"} · ${model.links.length} ${
                    model.links.length === 1 ? "link" : "links"
                  }`}
              {model.isolatedCount > 0 && !filtering ? ` · ${model.isolatedCount} unlinked` : ""}
            </p>
          </div>

          <div className="relative min-h-0 flex-1">
            <ForceGraphCanvas
              nodes={model.nodes}
              links={model.links}
              matched={match.matched}
              onSelect={(id) => navigate(pageHref(workspace.slug, id))}
            />
            {model.links.length === 0 ? (
              <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-xs text-muted-foreground">
                No links yet — connect pages by typing [[ inside a page.
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function GraphSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true" aria-label="Loading graph">
      <Skeleton className="size-64 rounded-full" />
    </div>
  );
}
