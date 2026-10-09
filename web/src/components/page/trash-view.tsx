"use client";

import { useQuery } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { PageIcon } from "@/components/common/page-icon";
import { TopBar } from "@/components/layout/topbar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { usePageActions } from "@/hooks/use-page-actions";
import { trashOptions } from "@/lib/api/queries";
import { formatRelative, useNow } from "@/lib/time";
import { pageTitle } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PageSummary } from "@hostidian/api-types";

export function TrashView() {
  const { workspace } = useWorkspace();
  const actions = usePageActions();
  const now = useNow();
  const query = useQuery(trashOptions(workspace.id));
  const [confirming, setConfirming] = useState<PageSummary | null>(null);
  const [purging, setPurging] = useState(false);
  useDocumentTitle("Trash");

  return (
    <>
      <TopBar>
        <span className="px-1.5 text-[13px] font-medium">Trash</span>
      </TopBar>
      <div className="mx-auto w-full max-w-3xl px-5 pb-16 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] md:px-10">
        <div className="pt-8 pb-4 md:pt-12">
          <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pages you moved to the Trash. Restoring a page brings back its sub-pages too.
          </p>
        </div>

        {query.isPending ? (
          <div className="grid gap-2" aria-busy="true" aria-label="Loading trash">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            title="Couldn't load the Trash"
            description="Check your connection and try again."
            action={<Button onClick={() => void query.refetch()}>Try again</Button>}
          />
        ) : query.data.length === 0 ? (
          <EmptyState
            icon={Trash2}
            title="Trash is empty"
            description="Pages you delete will wait here until you remove them permanently."
          />
        ) : (
          <ul className="divide-y rounded-xl border">
            {query.data.map((page) => (
              <li key={page.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                <PageIcon icon={page.icon} emojiClassName="text-lg" className="size-5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{pageTitle(page.title)}</p>
                  {page.archivedAt && (
                    <p className="text-xs text-muted-foreground">
                      Deleted {formatRelative(page.archivedAt, now || Date.parse(page.archivedAt))}
                    </p>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => actions.restore(page.id)}>
                    <RotateCcw /> Restore
                  </Button>
                  <Button variant="destructive-ghost" size="sm" onClick={() => setConfirming(page)}>
                    <Trash2 /> Delete forever
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !purging && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirming ? pageTitle(confirming.title) : ""}” forever?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the page and everything inside it, including attachments and comments. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={purging}
              onClick={async (e) => {
                e.preventDefault();
                if (!confirming) return;
                setPurging(true);
                await actions.purge(confirming.id);
                setPurging(false);
                setConfirming(null);
              }}
            >
              {purging ? "Deleting…" : "Delete forever"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
