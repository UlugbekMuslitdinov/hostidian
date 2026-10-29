import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { PageDetail, PageSummary, WorkspaceEvent } from "@hostidian/api-types";
import { qk } from "../api/keys";
import { PAGE_MUTATION_SCOPE } from "../query/mutations";
import { buildTree, descendantIds, upsertPage } from "../tree";

/** Event types the server may send (conventions §5); each needs its own EventSource listener. */
export const WORKSPACE_EVENT_TYPES = [
  "page.created",
  "page.updated",
  "page.moved",
  "page.archived",
  "page.restored",
  "page.deleted",
  "permissions.changed",
  "comment.created",
  "comment.updated",
  "comment.resolved",
  "comment.deleted",
  "member.changed",
] as const;

export function isPageSummary(value: unknown): value is PageSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PageSummary>;
  return (
    typeof v.id === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.title === "string" &&
    typeof v.position === "string" &&
    "parentId" in v
  );
}

export type Scheduler = (key: QueryKey, delayMs?: number) => void;

function listKeys(qc: QueryClient, workspaceId: string): QueryKey[] {
  return [
    qk.pages(workspaceId),
    qk.favorites(workspaceId),
    qk.trash(workspaceId),
    ...qc.getQueriesData({ queryKey: qk.recent(workspaceId) }).map(([key]) => key),
  ];
}

function patchEverywhere(qc: QueryClient, workspaceId: string, page: PageSummary) {
  for (const key of listKeys(qc, workspaceId)) {
    qc.setQueryData<PageSummary[]>(key, (old) =>
      old?.some((p) => p.id === page.id) ? old.map((p) => (p.id === page.id ? page : p)) : old,
    );
  }
  qc.setQueryData<PageDetail>(qk.page(page.id), (old) => (old ? { ...old, page } : old));
}

/**
 * Patch/invalidate the query cache for one SSE event. Events are hints (conventions §5): when in doubt
 * we invalidate, and `schedule` coalesces bursts into one refetch.
 *
 * While local tree mutations are queued/in flight we skip list refetches: they would clobber optimistic
 * state, and `settle()` in mutations.ts re-syncs once the queue drains anyway.
 */
export function applyWorkspaceEvent(qc: QueryClient, event: WorkspaceEvent, schedule: Scheduler): void {
  const ws = event.workspaceId;
  const localMutationsPending = qc.isMutating({ predicate: (m) => m.options.scope?.id === PAGE_MUTATION_SCOPE.id }) > 0;
  const refreshLists = () => {
    if (localMutationsPending) return;
    schedule(qk.pages(ws));
    schedule(qk.favorites(ws));
    schedule(qk.recent(ws));
  };
  const pageId = event.pageId;

  switch (event.type) {
    case "page.created": {
      if (isPageSummary(event.data) && !localMutationsPending) {
        const page = event.data;
        qc.setQueryData<PageSummary[]>(qk.pages(ws), (old) => (old ? upsertPage(old, page) : old));
      }
      refreshLists();
      schedule(qk.githubIssues(ws), 2000); // a page created by the GitHub sync brings a new #number
      break;
    }
    case "page.updated": {
      if (isPageSummary(event.data) && !localMutationsPending) patchEverywhere(qc, ws, event.data);
      if (pageId) schedule(qk.page(pageId), 1500); // "last edited by/at"
      schedule(qk.recent(ws), 3000);
      break;
    }
    case "page.moved": {
      if (isPageSummary(event.data) && !localMutationsPending) patchEverywhere(qc, ws, event.data);
      refreshLists();
      break;
    }
    case "page.archived": {
      if (pageId && !localMutationsPending) {
        const list = qc.getQueryData<PageSummary[]>(qk.pages(ws));
        const gone = new Set([pageId, ...(list ? descendantIds(buildTree(list), pageId) : [])]);
        const drop = (l: PageSummary[] | undefined) => l?.filter((p) => !gone.has(p.id));
        for (const key of [qk.pages(ws), qk.favorites(ws)]) qc.setQueryData<PageSummary[]>(key, drop);
      }
      schedule(qk.trash(ws));
      if (pageId) schedule(qk.page(pageId));
      refreshLists();
      break;
    }
    case "page.restored": {
      schedule(qk.trash(ws));
      if (pageId) schedule(qk.page(pageId));
      refreshLists();
      break;
    }
    case "page.deleted": {
      if (pageId) {
        qc.setQueryData<PageSummary[]>(qk.trash(ws), (old) => old?.filter((p) => p.id !== pageId));
        qc.removeQueries({ queryKey: qk.page(pageId) });
      }
      refreshLists();
      break;
    }
    case "permissions.changed": {
      for (const key of [qk.pages(ws), qk.favorites(ws), qk.trash(ws), qk.recent(ws)]) schedule(key, 100);
      if (pageId) {
        schedule(qk.page(pageId), 100);
        schedule(qk.pagePermissions(pageId), 100);
      }
      break;
    }
    case "comment.created":
    case "comment.updated":
    case "comment.resolved":
    case "comment.deleted": {
      if (pageId) schedule(qk.comments(pageId), 150);
      break;
    }
    case "member.changed": {
      schedule(qk.members(ws));
      schedule(qk.invites(ws));
      schedule(qk.me());
      break;
    }
  }
}
