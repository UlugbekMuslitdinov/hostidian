"use client";

import { FileQuestion, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { PublicPage } from "@hostidian/api-types";
import { EmptyState } from "@/components/common/empty-state";
import { LogoMark } from "@/components/common/logo";
import { PageIcon } from "@/components/common/page-icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { hasStatus, isNetworkError } from "@/lib/api/error";
import { PublicBlocks } from "./public-blocks";
import { PublicPageTree } from "./public-page-tree";
import { allowedPageIds, publicCoverBackground, publicPagePath, publicPageTitles } from "./public-share";
import { usePublicPage } from "./use-public-page";

/** Entry point rendered by both `/s/[token]` and `/s/[token]/[pageId]` route files. */
export function PublicPageView({ token, pageId }: { token: string; pageId?: string }) {
  // Key by the requested page so navigating between shared pages restarts from a fresh loading state.
  return <PublicPageLoader key={`${token}:${pageId ?? ""}`} token={token} pageId={pageId} />;
}

function PublicPageLoader({ token, pageId }: { token: string; pageId?: string }) {
  const { state, reload } = usePublicPage(token, pageId);

  if (state.status === "loading") return <PublicPageSkeleton />;
  if (state.status === "error") return <PublicUnavailable error={state.error} onRetry={reload} />;
  return <PublicPageContent token={token} data={state.data} />;
}

function SiteHeader() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-12 w-full max-w-[1080px] items-center gap-2 px-5 md:px-8">
        <LogoMark className="size-6" />
        <span className="text-sm font-semibold">Hostidian</span>
        <span className="ml-auto text-xs text-muted-foreground">Shared page · read-only</span>
      </div>
    </header>
  );
}

function PublicPageContent({ token, data }: { token: string; data: PublicPage }) {
  const router = useRouter();
  const { page, tree, rootPageId, includeSubpages } = data;

  const ids = useMemo(() => allowedPageIds(rootPageId, tree), [rootPageId, tree]);
  const titles = useMemo(() => publicPageTitles(tree), [tree]);
  const cover = publicCoverBackground(page.cover, token);
  const showTree = includeSubpages && tree.length > 1;
  const onNavigate = (id: string) => router.push(publicPagePath(token, id));

  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      {cover ? (
        <div
          className="h-[24vh] max-h-[220px] min-h-[110px] w-full"
          style={{ background: cover }}
          role="img"
          aria-label="Page cover"
        />
      ) : null}

      <div className="mx-auto flex w-full max-w-[1080px] gap-8 px-5 md:px-8">
        {showTree ? (
          <aside className="hidden w-60 shrink-0 py-8 lg:block">
            <PublicPageTree tree={tree} token={token} currentPageId={page.id} />
          </aside>
        ) : null}

        <main className="min-w-0 flex-1 py-8">
          <article>
            <header className="mb-1">
              {page.icon ? (
                <span className="mb-2 flex text-[60px] leading-none" aria-hidden="true">
                  <PageIcon icon={page.icon} className="size-10" />
                </span>
              ) : null}
              <h1 className="text-[30px] leading-tight font-bold tracking-tight break-words md:text-[40px]">
                {page.title || "Untitled"}
              </h1>
            </header>

            <div data-page-editor="" className="mt-4">
              <PublicBlocks
                key={page.id}
                blocks={data.blocks}
                token={token}
                allowedPageIds={ids}
                titles={titles}
                onNavigate={onNavigate}
              />
            </div>
          </article>
        </main>
      </div>
    </div>
  );
}

function PublicUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const missing = hasStatus(error, 403, 404);
  const offline = isNetworkError(error);
  return (
    <div className="min-h-dvh bg-background">
      <SiteHeader />
      <div className="mx-auto w-full max-w-[1080px] px-5 py-16 md:px-8">
        <EmptyState
          icon={missing ? FileQuestion : WifiOff}
          title={missing ? "This link is unavailable" : offline ? "You're offline" : "Couldn't load this page"}
          description={
            missing
              ? "This share link is invalid, expired, or was turned off by its owner."
              : offline
                ? "Hostidian can't reach the server right now. Check your connection and try again."
                : "Something went wrong while loading this page. Please try again."
          }
          action={missing ? undefined : <Button onClick={onRetry}>Try again</Button>}
        />
      </div>
    </div>
  );
}

function PublicPageSkeleton() {
  return (
    <div className="min-h-dvh bg-background" aria-busy="true" aria-label="Loading shared page">
      <SiteHeader />
      <div className="mx-auto w-full max-w-[1080px] px-5 pt-10 md:px-8">
        <Skeleton className="mb-6 h-10 w-3/5" />
        <Skeleton className="mb-3 h-4 w-full" />
        <Skeleton className="mb-3 h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}
