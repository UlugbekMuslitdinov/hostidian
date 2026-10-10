"use client";

import { Network, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useLinkRefresh } from "@/components/backlinks/use-link-refresh";
import { EmptyState } from "@/components/common/empty-state";
import { TopBar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAppNavigate } from "@/lib/nav";
import { pageHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { DepthPicker } from "./depth-picker";
import { ForceGraphCanvas } from "./force-graph";
import { GraphNodeList } from "./node-list";
import { recallLastPage } from "./last-page";
import { useGraph } from "./use-graph";

/**
 * Interactive link graph for the current workspace: pages as nodes, wikilinks as edges. `?focus=<pageId>` (set by
 * the page's "Open full graph" link) opens it as a local graph around that page.
 */
export function GraphView() {
  const focus = useSearchParams().get("focus");
  return <GraphScreen key={focus ?? ""} focus={focus} />;
}

function GraphScreen({ focus }: { focus: string | null }) {
  const { workspace } = useWorkspace();
  const navigate = useAppNavigate();
  const [filter, setFilter] = useState("");
  const [depth, setDepth] = useState(1);
  // Local graph needs a centre: the page we came from, else the last page the user had open.
  const [candidate] = useState(() => focus ?? recallLastPage(workspace.id));
  const [localRequested, setLocalRequested] = useState(Boolean(focus));
  useDocumentTitle("Graph");
  useLinkRefresh(workspace.id);

  const { query, full, model, match } = useGraph(workspace.id, filter, {
    local: localRequested && candidate ? { centerId: candidate, depth } : null,
  });
  const centre = candidate ? full.nodes.find((node) => node.id === candidate) : undefined;
  const canLocal = Boolean(centre);
  const local = localRequested && canLocal;
  const hasPages = (query.data?.nodes.length ?? 0) > 0;
  const filtering = filter.trim().length > 0;
  const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2">
            <div className="relative w-full sm:w-64">
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
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={local}
                disabled={!canLocal}
                onCheckedChange={setLocalRequested}
                aria-label="Local graph"
              />
              <span title={canLocal ? undefined : "Open a page first, then open its local graph."}>
                {local && centre ? `Local graph: ${centre.title}` : "Local graph"}
              </span>
            </label>
            {local ? <DepthPicker depth={depth} onChange={setDepth} /> : null}
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {filtering
                ? `${match.count} of ${noun(model.nodes.length, "page", "pages")}`
                : `${noun(model.nodes.length, "page", "pages")} · ${noun(model.links.length, "link", "links")}`}
              {model.isolatedCount > 0 && !filtering && !local ? ` · ${model.isolatedCount} unlinked` : ""}
            </p>
          </div>

          <div className="relative min-h-0 flex-1">
            <ForceGraphCanvas
              nodes={model.nodes}
              links={model.links}
              matched={match.matched}
              centerId={local ? centre?.id : undefined}
              onSelect={(id) => navigate(pageHref(workspace.slug, id))}
            />
            <GraphNodeList nodes={model.nodes} />
            {model.links.length === 0 ? (
              <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-xs text-muted-foreground">
                {local ? "This page has no links yet." : "No links yet — connect pages by typing [[ inside a page."}
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
