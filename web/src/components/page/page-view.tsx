"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FileQuestion, MessageSquare, Trash2, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { CommentsProvider } from "@/components/comments/comments-context";
import { CommentsDock } from "@/components/comments/comments-dock";
import { PageEditor } from "@/components/editor/page-editor";
import { TopBar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { usePageActions } from "@/hooks/use-page-actions";
import { pageDetailOptions } from "@/lib/api/queries";
import { hasStatus, isNetworkError } from "@/lib/api/error";
import { canComment, canEdit } from "@/lib/permissions";
import { formatRelative, useNow } from "@/lib/time";
import { AppLink } from "@/lib/nav";
import { pageTitle, workspaceHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PageDetail } from "@hostidian/api-types";
import { BacklinksPanel } from "./backlinks-panel";
import { PageHeader } from "./page-header";
import { PageCover, PageTitleBlock } from "./page-title-block";
import { PresenceProvider } from "./presence";

export function PageView({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const { workspace } = useWorkspace();
  const query = useQuery(pageDetailOptions(qc, pageId));
  const detail = query.data;
  useDocumentTitle(detail ? pageTitle(detail.page.title) : null);

  if (!detail) {
    if (query.isError) {
      const missing = hasStatus(query.error, 403, 404);
      return (
        <>
          <TopBar />
          <EmptyState
            icon={missing ? FileQuestion : WifiOff}
            title={
              missing ? "Page not found" : isNetworkError(query.error) ? "You're offline" : "Couldn't load this page"
            }
            description={
              missing
                ? "It may have been deleted, or you may not have access to it."
                : isNetworkError(query.error)
                  ? "This page isn't available offline yet. Reconnect and try again."
                  : "Something went wrong while loading the page."
            }
            action={
              missing ? (
                <Button asChild>
                  <AppLink href={workspaceHref(workspace.slug)}>Back to home</AppLink>
                </Button>
              ) : (
                <Button onClick={() => void query.refetch()}>Try again</Button>
              )
            }
          />
        </>
      );
    }
    return <PageSkeleton />;
  }

  return (
    <PresenceProvider>
      <PageContent key={detail.page.id} detail={detail} />
    </PresenceProvider>
  );
}

function PageContent({ detail }: { detail: PageDetail }) {
  const actions = usePageActions();
  const now = useNow();
  const { page } = detail;
  const editable = canEdit(page.role) && !page.archivedAt;

  return (
    <CommentsProvider pageId={page.id} role={page.role}>
      <div className="min-h-full pb-safe">
        {/* The visible title is an editable textarea; this gives assistive tech a page heading. */}
        <h1 className="sr-only">{pageTitle(page.title)}</h1>
        <PageHeader detail={detail} actions={actions} />

        <div className="flex items-start">
          <div className="min-w-0 flex-1">
            <PageCover cover={page.cover} editable={editable} onChange={(cover) => actions.updateMeta(page.id, { cover })} />

            <div className="mx-auto w-full max-w-[720px] px-5 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] md:px-8">
              {page.archivedAt ? (
                <Banner icon={<Trash2 className="size-4" />} tone="warning">
                  This page is in the Trash.
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto bg-background"
                    onClick={() => actions.restore(page.id)}
                  >
                    Restore
                  </Button>
                </Banner>
              ) : !canEdit(page.role) ? (
                <Banner icon={canComment(page.role) ? <MessageSquare className="size-4" /> : <Eye className="size-4" />}>
                  {canComment(page.role)
                    ? "You can comment on this page, but not edit it."
                    : "You have view-only access to this page."}
                </Banner>
              ) : null}

              <PageTitleBlock
                page={page}
                editable={editable}
                onSaveTitle={(title) => actions.updateMeta(page.id, { title })}
                onChangeIcon={(icon) => actions.updateMeta(page.id, { icon })}
                onChangeCover={(cover) => actions.updateMeta(page.id, { cover })}
              />

              <p className="mb-2 text-xs text-muted-foreground">
                Last edited {formatRelative(page.updatedAt, now || Date.parse(page.updatedAt))}
                {detail.lastEditedBy ? ` by ${detail.lastEditedBy.name}` : ""}
              </p>

              <PageEditor pageId={page.id} role={page.role} />
              <BacklinksPanel pageId={page.id} />
            </div>
          </div>

          <CommentsDock />
        </div>
      </div>
    </CommentsProvider>
  );
}

function Banner({
  icon,
  tone = "info",
  children,
}: {
  icon: ReactNode;
  tone?: "info" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={
        tone === "warning"
          ? "mt-4 flex min-h-11 items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
          : "mt-4 flex min-h-11 items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
      }
    >
      {icon}
      {children}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <TopBar>
        <Skeleton className="ml-2 h-4 w-40" />
      </TopBar>
      <div className="mx-auto w-full max-w-[720px] px-5 pt-10 md:px-8">
        <Skeleton className="mb-6 h-10 w-3/5" />
        <Skeleton className="mb-3 h-4 w-full" />
        <Skeleton className="mb-3 h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}
