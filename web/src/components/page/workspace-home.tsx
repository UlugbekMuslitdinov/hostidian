"use client";

import { useQuery } from "@tanstack/react-query";
import { FilePlus2, Star } from "lucide-react";
import type { ReactNode } from "react";
import { PageIcon } from "@/components/common/page-icon";
import { TopBar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { usePageActions } from "@/hooks/use-page-actions";
import { favoritesOptions, pagesOptions, recentOptions } from "@/lib/api/queries";
import { AppLink } from "@/lib/nav";
import { canCreateTopLevelPage } from "@/lib/permissions";
import { useSession } from "@/lib/session";
import { formatRelative, greetingFor, useNow } from "@/lib/time";
import { pageHref, pageTitle } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PageSummary } from "@hostidian/api-types";

export function WorkspaceHome() {
  const { workspace, role } = useWorkspace();
  const { user } = useSession();
  const actions = usePageActions();
  const now = useNow();
  useDocumentTitle(workspace.name);

  const recentQuery = useQuery(recentOptions(workspace.id, 12));
  const favoritesQuery = useQuery(favoritesOptions(workspace.id));
  const pagesQuery = useQuery(pagesOptions(workspace.id));

  const recent =
    recentQuery.data && recentQuery.data.length > 0
      ? recentQuery.data
      : [...(pagesQuery.data ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 12);
  const favorites = favoritesQuery.data ?? [];
  const canCreate = canCreateTopLevelPage(role);
  const loading = recentQuery.isPending && pagesQuery.isPending;
  const empty = !loading && recent.length === 0 && favorites.length === 0;

  return (
    <>
      <TopBar>
        <span className="truncate px-1.5 text-[13px] font-medium">{workspace.name}</span>
      </TopBar>
      <div className="mx-auto w-full max-w-4xl px-5 pb-16 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-3 pt-8 pb-6 md:pt-12">
          <div>
            <p className="text-sm text-muted-foreground">{now ? greetingFor(now) : "Welcome"}</p>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{user.name.split(" ")[0]}</h1>
          </div>
          {canCreate && (
            <Button onClick={() => actions.createPage({ parentId: null })}>
              <FilePlus2 /> New page
            </Button>
          )}
        </div>

        {loading && <CardsSkeleton />}

        {favorites.length > 0 && (
          <Section title="Favorites" icon={<Star className="size-4" />}>
            <PageCards pages={favorites} slug={workspace.slug} now={now} />
          </Section>
        )}

        {recent.length > 0 && (
          <Section title="Recently edited">
            <PageCards pages={recent} slug={workspace.slug} now={now} />
          </Section>
        )}

        {empty && (
          <div className="rounded-xl border border-dashed px-6 py-14 text-center">
            <h2 className="text-base font-semibold">This workspace is empty</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              {canCreate
                ? "Create your first page to start writing. Pages can be nested, shared and edited together in real time."
                : "Pages shared with you will show up here."}
            </p>
            {canCreate && (
              <Button className="mt-4" onClick={() => actions.createPage({ parentId: null })}>
                <FilePlus2 /> Create a page
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function PageCards({ pages, slug, now }: { pages: readonly PageSummary[]; slug: string; now: number }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {pages.map((page) => (
        <li key={page.id}>
          <AppLink
            href={pageHref(slug, page.id)}
            className="flex min-h-[88px] flex-col justify-between gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:bg-accent/60"
          >
            <PageIcon icon={page.icon} emojiClassName="text-2xl" className="size-6" />
            <span>
              <span className="line-clamp-2 block font-medium">{pageTitle(page.title)}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Edited {formatRelative(page.updatedAt, now || Date.parse(page.updatedAt))}
              </span>
            </span>
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading pages">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-[88px] rounded-xl" />
      ))}
    </div>
  );
}
