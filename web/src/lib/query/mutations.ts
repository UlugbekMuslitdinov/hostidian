import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { EffectiveRole, PageDetail, PageSummary, Visibility } from "@hostidian/api-types";
import { api } from "../api/client";
import { qk } from "../api/keys";
import { unwrap, unwrapVoid } from "../api/unwrap";
import { buildTree, ancestorPages, descendantIds, upsertPage } from "../tree";

/**
 * Every page-tree mutation is registered here, centrally, with `queryClient.setMutationDefaults`.
 * Keeping `mutationFn` + optimistic handlers in the defaults (not in components) is what lets paused
 * mutations be persisted and *resumed after a reload* (wave 2: `resumePausedMutations()`), because a
 * rehydrated mutation only knows its key and variables.
 *
 * Variables are therefore plain serialisable data and carry everything the handlers need.
 */

export const mutationKeys = {
  createPage: ["createPage"],
  renamePage: ["renamePage"],
  movePage: ["movePage"],
  archivePage: ["archivePage"],
  restorePage: ["restorePage"],
  toggleFavorite: ["toggleFavorite"],
  updatePageMeta: ["updatePageMeta"],
} as const;

/** All tree mutations run one at a time, in order (e.g. create a parent before its child, offline). */
export const PAGE_MUTATION_SCOPE = { id: "pages" } as const;

export interface CreatePageVars {
  workspaceId: string;
  /** Client-generated UUIDv7 (idempotent on the server). */
  id: string;
  parentId: string | null;
  title?: string;
  icon?: string | null;
  visibility?: Visibility;
  afterId?: string;
  beforeId?: string;
  /** Locally computed fractional position used for optimistic ordering; the server value wins. */
  position: string;
  createdBy: string;
  /** RFC 3339 timestamp used for the optimistic row. */
  now: string;
}

export interface RenamePageVars {
  workspaceId: string;
  pageId: string;
  title: string;
}

export interface PageMetaPatch {
  title?: string;
  icon?: string | null;
  cover?: string | null;
}

export interface UpdatePageMetaVars {
  workspaceId: string;
  pageId: string;
  patch: PageMetaPatch;
}

export interface MovePageVars {
  workspaceId: string;
  pageId: string;
  parentId: string | null;
  afterId?: string;
  beforeId?: string;
  /** Locally computed fractional position; server value wins. */
  position: string;
}

export interface PageRefVars {
  workspaceId: string;
  pageId: string;
}

export interface ToggleFavoriteVars extends PageRefVars {
  favorite: boolean;
}

type Snapshot = readonly [key: QueryKey, data: unknown];
export interface RollbackContext {
  snapshots: Snapshot[];
}

// ------------------------------------------------------------------ cache helpers

function snapshot(qc: QueryClient, keys: readonly QueryKey[]): Snapshot[] {
  return keys.map((key) => [key, qc.getQueryData(key)] as const);
}

function rollback(qc: QueryClient, context: RollbackContext | undefined) {
  for (const [key, data] of context?.snapshots ?? []) {
    if (data === undefined) qc.removeQueries({ queryKey: key, exact: true });
    else qc.setQueryData(key, data);
  }
}

function updateList(qc: QueryClient, key: QueryKey, fn: (list: PageSummary[]) => PageSummary[]) {
  qc.setQueryData<PageSummary[]>(key, (old) => (old ? fn(old) : old));
}

/** The recent list is cached per `limit`; touch all variants. */
function recentKeys(qc: QueryClient, workspaceId: string): QueryKey[] {
  return qc.getQueriesData({ queryKey: qk.recent(workspaceId) }).map(([key]) => key);
}

function listKeys(qc: QueryClient, workspaceId: string): QueryKey[] {
  return [qk.pages(workspaceId), qk.favorites(workspaceId), qk.trash(workspaceId), ...recentKeys(qc, workspaceId)];
}

/** Apply `patch` to a page everywhere it is cached (tree, favourites, recents, trash, detail). */
function patchPage(qc: QueryClient, workspaceId: string, pageId: string, patch: Partial<PageSummary>) {
  const apply = (list: PageSummary[]) => list.map((p) => (p.id === pageId ? { ...p, ...patch } : p));
  for (const key of listKeys(qc, workspaceId)) updateList(qc, key, apply);
  qc.setQueryData<PageDetail>(qk.page(pageId), (old) => (old ? { ...old, page: { ...old.page, ...patch } } : old));
}

function pageSnapshotKeys(qc: QueryClient, workspaceId: string, pageId: string): QueryKey[] {
  return [...listKeys(qc, workspaceId), qk.page(pageId)];
}

function findCachedPage(qc: QueryClient, workspaceId: string, pageId: string): PageSummary | undefined {
  for (const key of listKeys(qc, workspaceId)) {
    const hit = qc.getQueryData<PageSummary[]>(key)?.find((p) => p.id === pageId);
    if (hit) return hit;
  }
  return qc.getQueryData<PageDetail>(qk.page(pageId))?.page;
}

function hasPendingPageMutations(qc: QueryClient, excluding = 1): boolean {
  return qc.isMutating({ predicate: (m) => m.options.scope?.id === PAGE_MUTATION_SCOPE.id }) > excluding;
}

/**
 * Re-sync with the server once the *last* queued tree mutation settles; refetching in between would
 * overwrite the optimistic state of mutations that are still waiting in the queue.
 */
function settle(qc: QueryClient, workspaceId: string) {
  if (hasPendingPageMutations(qc)) return;
  void qc.invalidateQueries({ queryKey: qk.pages(workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.favorites(workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.trash(workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.recent(workspaceId) });
}

export function optimisticPage(vars: CreatePageVars, role: EffectiveRole): PageSummary {
  return {
    id: vars.id,
    workspaceId: vars.workspaceId,
    parentId: vars.parentId,
    title: vars.title ?? "",
    icon: vars.icon ?? null,
    cover: null,
    position: vars.position,
    // Visibility only applies to roots; children store the default.
    visibility: vars.parentId === null ? (vars.visibility ?? "workspace") : "workspace",
    role,
    createdBy: vars.createdBy,
    createdAt: vars.now,
    updatedAt: vars.now,
    archivedAt: null,
  };
}

// ------------------------------------------------------------------ registration

export function setupMutationDefaults(qc: QueryClient): void {
  // --- createPage ----------------------------------------------------------------------------
  qc.setMutationDefaults<PageSummary, Error, CreatePageVars, RollbackContext>(mutationKeys.createPage, {
    scope: PAGE_MUTATION_SCOPE,
    meta: { errorTitle: "Couldn't create the page" },
    mutationFn: (vars: CreatePageVars) =>
      unwrap(
        api.POST("/workspaces/{workspaceId}/pages", {
          params: { path: { workspaceId: vars.workspaceId } },
          body: {
            id: vars.id,
            parentId: vars.parentId,
            title: vars.title ?? "",
            icon: vars.icon ?? undefined,
            visibility: vars.parentId === null ? vars.visibility : undefined,
            afterId: vars.afterId,
            beforeId: vars.beforeId,
          },
        }),
      ),
    onMutate: async (vars: CreatePageVars): Promise<RollbackContext> => {
      await qc.cancelQueries({ queryKey: qk.pages(vars.workspaceId) });
      const context = { snapshots: snapshot(qc, [qk.pages(vars.workspaceId), qk.page(vars.id)]) };

      const list = qc.getQueryData<PageSummary[]>(qk.pages(vars.workspaceId));
      const parent = vars.parentId ? list?.find((p) => p.id === vars.parentId) : undefined;
      const page = optimisticPage(vars, parent?.role ?? "full");

      updateList(qc, qk.pages(vars.workspaceId), (old) => upsertPage(old, page));
      qc.setQueryData<PageDetail>(qk.page(vars.id), {
        page,
        breadcrumbs: list
          ? ancestorPages(buildTree([...list, page]), vars.id).map((a) => ({ id: a.id, title: a.title, icon: a.icon }))
          : [],
        isFavorite: false,
      });
      return context;
    },
    onSuccess: (page: PageSummary, vars: CreatePageVars) => {
      updateList(qc, qk.pages(vars.workspaceId), (old) => upsertPage(old, page));
      qc.setQueryData<PageDetail>(qk.page(vars.id), (old) => (old ? { ...old, page } : old));
    },
    onError: (_error: unknown, _vars: CreatePageVars, context: RollbackContext | undefined) => rollback(qc, context),
    onSettled: (_data: unknown, _error: unknown, vars: CreatePageVars) => settle(qc, vars.workspaceId),
  });

  // --- renamePage / updatePageMeta (same optimistic patch, different payload) -----------------
  const metaMutation = <V extends PageRefVars>(toPatch: (vars: V) => PageMetaPatch) => ({
    scope: PAGE_MUTATION_SCOPE,
    meta: { errorTitle: "Couldn't save your changes" },
    onMutate: async (vars: V): Promise<RollbackContext> => {
      await qc.cancelQueries({ queryKey: qk.pages(vars.workspaceId) });
      const context = { snapshots: snapshot(qc, pageSnapshotKeys(qc, vars.workspaceId, vars.pageId)) };
      patchPage(qc, vars.workspaceId, vars.pageId, toPatch(vars));
      return context;
    },
    onError: (_error: unknown, _vars: V, context: RollbackContext | undefined) => rollback(qc, context),
    onSettled: (_data: unknown, _error: unknown, vars: V) => settle(qc, vars.workspaceId),
  });

  qc.setMutationDefaults<PageSummary, Error, RenamePageVars, RollbackContext>(mutationKeys.renamePage, {
    ...metaMutation((v: RenamePageVars) => ({ title: v.title })),
    mutationFn: (vars: RenamePageVars) =>
      unwrap(api.PATCH("/pages/{pageId}", { params: { path: { pageId: vars.pageId } }, body: { title: vars.title } })),
  });

  qc.setMutationDefaults<PageSummary, Error, UpdatePageMetaVars, RollbackContext>(mutationKeys.updatePageMeta, {
    ...metaMutation((v: UpdatePageMetaVars) => v.patch),
    mutationFn: (vars: UpdatePageMetaVars) =>
      unwrap(api.PATCH("/pages/{pageId}", { params: { path: { pageId: vars.pageId } }, body: vars.patch })),
  });

  // --- movePage ------------------------------------------------------------------------------
  qc.setMutationDefaults<PageSummary, Error, MovePageVars, RollbackContext>(mutationKeys.movePage, {
    scope: PAGE_MUTATION_SCOPE,
    meta: { errorTitle: "Couldn't move the page" },
    mutationFn: (vars: MovePageVars) =>
      unwrap(
        api.POST("/pages/{pageId}/move", {
          params: { path: { pageId: vars.pageId } },
          body: { parentId: vars.parentId, afterId: vars.afterId, beforeId: vars.beforeId },
        }),
      ),
    onMutate: async (vars: MovePageVars): Promise<RollbackContext> => {
      await qc.cancelQueries({ queryKey: qk.pages(vars.workspaceId) });
      const context = { snapshots: snapshot(qc, pageSnapshotKeys(qc, vars.workspaceId, vars.pageId)) };
      patchPage(qc, vars.workspaceId, vars.pageId, { parentId: vars.parentId, position: vars.position });
      return context;
    },
    onSuccess: (page: PageSummary, vars: MovePageVars) => patchPage(qc, vars.workspaceId, vars.pageId, page),
    onError: (_error: unknown, _vars: MovePageVars, context: RollbackContext | undefined) => rollback(qc, context),
    onSettled: (_data: unknown, _error: unknown, vars: MovePageVars) => settle(qc, vars.workspaceId),
  });

  // --- archivePage ---------------------------------------------------------------------------
  qc.setMutationDefaults<void, Error, PageRefVars, RollbackContext>(mutationKeys.archivePage, {
    scope: PAGE_MUTATION_SCOPE,
    meta: { errorTitle: "Couldn't move the page to Trash" },
    mutationFn: (vars: PageRefVars) =>
      unwrapVoid(api.POST("/pages/{pageId}/archive", { params: { path: { pageId: vars.pageId } } })),
    onMutate: async (vars: PageRefVars): Promise<RollbackContext> => {
      const { workspaceId, pageId } = vars;
      await qc.cancelQueries({ queryKey: qk.pages(workspaceId) });
      const context = { snapshots: snapshot(qc, pageSnapshotKeys(qc, workspaceId, pageId)) };

      const list = qc.getQueryData<PageSummary[]>(qk.pages(workspaceId));
      const gone = new Set([pageId, ...(list ? descendantIds(buildTree(list), pageId) : [])]);
      const archived = findCachedPage(qc, workspaceId, pageId);
      const drop = (l: PageSummary[]) => l.filter((p) => !gone.has(p.id));
      updateList(qc, qk.pages(workspaceId), drop);
      updateList(qc, qk.favorites(workspaceId), drop);
      for (const key of recentKeys(qc, workspaceId)) updateList(qc, key, drop);
      if (archived) {
        const at = new Date().toISOString();
        updateList(qc, qk.trash(workspaceId), (old) => upsertPage(old, { ...archived, archivedAt: at }));
      }
      return context;
    },
    onError: (_error: unknown, _vars: PageRefVars, context: RollbackContext | undefined) => rollback(qc, context),
    onSettled: (_data: unknown, _error: unknown, vars: PageRefVars) => settle(qc, vars.workspaceId),
  });

  // --- restorePage ---------------------------------------------------------------------------
  qc.setMutationDefaults<PageSummary, Error, PageRefVars, RollbackContext>(mutationKeys.restorePage, {
    scope: PAGE_MUTATION_SCOPE,
    meta: { errorTitle: "Couldn't restore the page" },
    mutationFn: (vars: PageRefVars) =>
      unwrap(api.POST("/pages/{pageId}/restore", { params: { path: { pageId: vars.pageId } } })),
    onMutate: async (vars: PageRefVars): Promise<RollbackContext> => {
      await qc.cancelQueries({ queryKey: qk.trash(vars.workspaceId) });
      const context = { snapshots: snapshot(qc, [qk.trash(vars.workspaceId), qk.pages(vars.workspaceId)]) };
      updateList(qc, qk.trash(vars.workspaceId), (old) => old.filter((p) => p.id !== vars.pageId));
      return context;
    },
    onSuccess: (page: PageSummary, vars: PageRefVars) => {
      updateList(qc, qk.pages(vars.workspaceId), (old) => upsertPage(old, page));
    },
    onError: (_error: unknown, _vars: PageRefVars, context: RollbackContext | undefined) => rollback(qc, context),
    onSettled: (_data: unknown, _error: unknown, vars: PageRefVars) => settle(qc, vars.workspaceId),
  });

  // --- toggleFavorite ------------------------------------------------------------------------
  qc.setMutationDefaults<void, Error, ToggleFavoriteVars, RollbackContext>(mutationKeys.toggleFavorite, {
    scope: PAGE_MUTATION_SCOPE,
    meta: { errorTitle: "Couldn't update favorites" },
    mutationFn: (vars: ToggleFavoriteVars) =>
      vars.favorite
        ? unwrapVoid(api.PUT("/pages/{pageId}/favorite", { params: { path: { pageId: vars.pageId } } }))
        : unwrapVoid(api.DELETE("/pages/{pageId}/favorite", { params: { path: { pageId: vars.pageId } } })),
    onMutate: async (vars: ToggleFavoriteVars): Promise<RollbackContext> => {
      const { workspaceId, pageId, favorite } = vars;
      await qc.cancelQueries({ queryKey: qk.favorites(workspaceId) });
      const context = { snapshots: snapshot(qc, [qk.favorites(workspaceId), qk.page(pageId)]) };

      const page = findCachedPage(qc, workspaceId, pageId);
      updateList(qc, qk.favorites(workspaceId), (old) =>
        favorite ? (page ? upsertPage(old, page) : old) : old.filter((p) => p.id !== pageId),
      );
      qc.setQueryData<PageDetail>(qk.page(pageId), (old) => (old ? { ...old, isFavorite: favorite } : old));
      return context;
    },
    onError: (_error: unknown, _vars: ToggleFavoriteVars, context: RollbackContext | undefined) =>
      rollback(qc, context),
    onSettled: (_data: unknown, _error: unknown, vars: ToggleFavoriteVars) => settle(qc, vars.workspaceId),
  });
}
