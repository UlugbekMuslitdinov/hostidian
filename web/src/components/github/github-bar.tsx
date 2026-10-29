"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDot, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { OnlineOnly } from "@/components/pwa/online-only";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import { issueLabel } from "@/lib/github";
import { formatRelative, useNow } from "@/lib/time";
import { useWorkspace } from "@/lib/workspace";
import type { PageDetail, PageGithub } from "@hostidian/api-types";

/**
 * Header of a page that is synced with a GitHub issue: which issue, whether it is open, when the two last agreed
 * and, if the last attempt failed, why. Closing/reopening goes straight to GitHub.
 */
export function GithubBar({
  pageId,
  github,
  canEdit,
  canManage,
}: {
  pageId: string;
  github: PageGithub;
  /** The user may edit the page, hence close/reopen the issue. */
  canEdit: boolean;
  /** Workspace owner/admin: may trigger a sync (the endpoint is admin-only). */
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const now = useNow();
  const { workspace } = useWorkspace();
  const open = github.state === "open";

  const toggle = useMutation({
    mutationFn: (state: PageGithub["state"]) =>
      unwrap(api.PUT("/pages/{pageId}/github/state", { params: { path: { pageId } }, body: { state } })),
    onSuccess: (next) => {
      qc.setQueryData<PageDetail>(qk.page(pageId), (old) => (old ? { ...old, github: next } : old));
      void qc.invalidateQueries({ queryKey: qk.githubIssues(workspace.id) });
    },
    onError: (e) => toast.error("Couldn't update the GitHub issue", { description: errorMessage(e) }),
  });

  const retry = useMutation({
    mutationFn: () =>
      unwrapVoid(
        api.POST("/integrations/github/{connectionId}/sync", { params: { path: { connectionId: github.connectionId } } }),
      ),
    onSuccess: () => {
      toast.success("Sync scheduled");
      void qc.invalidateQueries({ queryKey: qk.page(pageId) });
    },
    onError: (e) => toast.error("Couldn't start the sync", { description: errorMessage(e) }),
  });

  return (
    <section
      aria-label="GitHub issue"
      className="mb-3 grid gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <a
          href={github.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 font-medium hover:underline"
        >
          {open ? (
            <CircleDot className="size-4 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <CircleCheck className="size-4 shrink-0 text-[#8250df]" aria-hidden="true" />
          )}
          <span className="truncate">
            {github.repository}
            {issueLabel(github)}
          </span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        </a>
        <Badge variant={open ? "success" : "default"}>{open ? "Open" : "Closed"}</Badge>
        <span className="text-xs text-muted-foreground">
          Synced {formatRelative(github.lastSyncedAt, now || Date.parse(github.lastSyncedAt))}
        </span>
        {canEdit ? (
          <OnlineOnly reason="Changing the issue needs a connection." className="ml-auto">
            <Button
              size="sm"
              variant="outline"
              className="ml-auto bg-background"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(open ? "closed" : "open")}
            >
              {open ? "Close issue" : "Reopen issue"}
            </Button>
          </OnlineOnly>
        ) : null}
      </div>
      {github.error ? (
        <p role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-destructive">
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">Couldn&apos;t sync with GitHub: {github.error}</span>
          {canManage ? (
            <OnlineOnly reason="Syncing needs a connection.">
              <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate()}>
                <RefreshCw /> Retry
              </Button>
            </OnlineOnly>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
