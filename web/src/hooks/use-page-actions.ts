"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { v7 as uuidv7 } from "uuid";
import type { PageSummary, Visibility } from "@hostidian/api-types";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import { downloadBlob, filenameFromDisposition, sanitizeFilename } from "@/lib/download";
import { computePosition } from "@/lib/position";
import {
  mutationKeys,
  type CreatePageVars,
  type MovePageVars,
  type PageMetaPatch,
  type PageRefVars,
  type RenamePageVars,
  type ToggleFavoriteVars,
  type UpdatePageMetaVars,
} from "@/lib/query/mutations";
import { useAppNavigate, useRoute } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { buildTree, isDescendant, type MoveTarget } from "@/lib/tree";
import { absoluteUrl, copyToClipboard, pageHref, workspaceHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

export interface CreatePageOptions {
  parentId?: string | null;
  visibility?: Visibility;
  title?: string;
  icon?: string | null;
  afterId?: string;
  beforeId?: string;
  /** Open the new page right away (default true). */
  navigate?: boolean;
}

/**
 * All page-level operations used by the sidebar, page header, home, trash and command palette.
 * Offline-capable ones go through the mutations registered in setupMutationDefaults(); the rest
 * (duplicate, purge, export) need the server and fail gracefully when offline.
 */
export function usePageActions() {
  const qc = useQueryClient();
  const navigate = useAppNavigate();
  const route = useRoute();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const workspaceId = workspace.id;
  const slug = workspace.slug;
  const openPageId = route.kind === "page" ? route.pageId : undefined;

  const createM = useMutation<PageSummary, Error, CreatePageVars>({ mutationKey: mutationKeys.createPage });
  const renameM = useMutation<PageSummary, Error, RenamePageVars>({ mutationKey: mutationKeys.renamePage });
  const metaM = useMutation<PageSummary, Error, UpdatePageMetaVars>({ mutationKey: mutationKeys.updatePageMeta });
  const moveM = useMutation<PageSummary, Error, MovePageVars>({ mutationKey: mutationKeys.movePage });
  const archiveM = useMutation<void, Error, PageRefVars>({ mutationKey: mutationKeys.archivePage });
  const restoreM = useMutation<PageSummary, Error, PageRefVars>({ mutationKey: mutationKeys.restorePage });
  const favoriteM = useMutation<void, Error, ToggleFavoriteVars>({ mutationKey: mutationKeys.toggleFavorite });

  const createMutate = createM.mutate;

  const cachedPages = useCallback(() => qc.getQueryData<PageSummary[]>(qk.pages(workspaceId)) ?? [], [qc, workspaceId]);

  const createPage = useCallback(
    (opts: CreatePageOptions = {}): string => {
      const id = uuidv7();
      const parentId = opts.parentId ?? null;
      const siblings = cachedPages().filter((p) => p.parentId === parentId);
      createMutate({
        workspaceId,
        id,
        parentId,
        title: opts.title,
        icon: opts.icon,
        visibility: opts.visibility,
        afterId: opts.afterId,
        beforeId: opts.beforeId,
        position: computePosition(siblings, { afterId: opts.afterId, beforeId: opts.beforeId }),
        createdBy: user.id,
        now: new Date().toISOString(),
      });
      if (opts.navigate !== false) navigate(pageHref(slug, id));
      return id;
    },
    [cachedPages, createMutate, navigate, slug, user.id, workspaceId],
  );

  const renamePage = renameM.mutate;
  const updatePage = metaM.mutate;
  const toggleFavorite = favoriteM.mutate;
  const restoreMutate = restoreM.mutate;
  const archiveMutate = archiveM.mutate;
  const moveMutate = moveM.mutate;

  const rename = useCallback(
    (pageId: string, title: string) => renamePage({ workspaceId, pageId, title }),
    [renamePage, workspaceId],
  );

  const updateMeta = useCallback(
    (pageId: string, patch: PageMetaPatch) => updatePage({ workspaceId, pageId, patch }),
    [updatePage, workspaceId],
  );

  const setFavorite = useCallback(
    (pageId: string, favorite: boolean) => toggleFavorite({ workspaceId, pageId, favorite }),
    [toggleFavorite, workspaceId],
  );

  const restore = useCallback((pageId: string) => restoreMutate({ workspaceId, pageId }), [restoreMutate, workspaceId]);

  const archive = useCallback(
    (pageId: string) => {
      const list = cachedPages();
      const tree = buildTree(list);
      const title = tree.byId.get(pageId)?.page.title || "Untitled";
      const leaveOpenPage = openPageId !== undefined && isDescendant(tree, openPageId, pageId);
      archiveMutate({ workspaceId, pageId });
      if (leaveOpenPage) navigate(workspaceHref(slug), { replace: true });
      toast(`"${title}" moved to Trash`, {
        action: { label: "Undo", onClick: () => restoreMutate({ workspaceId, pageId }) },
        duration: 6000,
      });
    },
    [archiveMutate, cachedPages, navigate, openPageId, restoreMutate, slug, workspaceId],
  );

  const move = useCallback(
    (pageId: string, target: MoveTarget) => {
      const siblings = cachedPages().filter((p) => p.parentId === target.parentId);
      moveMutate({
        workspaceId,
        pageId,
        parentId: target.parentId,
        afterId: target.afterId,
        beforeId: target.beforeId,
        position: computePosition(siblings, { ...target, excludeId: pageId }),
      });
    },
    [cachedPages, moveMutate, workspaceId],
  );

  const duplicate = useCallback(
    async (pageId: string) => {
      const toastId = toast.loading("Duplicating…");
      try {
        const copy = await unwrap(
          api.POST("/pages/{pageId}/duplicate", {
            params: { path: { pageId } },
            body: { includeSubpages: true },
          }),
        );
        await qc.invalidateQueries({ queryKey: qk.pages(workspaceId) });
        toast.success("Page duplicated", { id: toastId });
        navigate(pageHref(slug, copy.id));
      } catch (error) {
        toast.error("Couldn't duplicate the page", { id: toastId, description: errorMessage(error) });
      }
    },
    [navigate, qc, slug, workspaceId],
  );

  const purge = useCallback(
    async (pageId: string) => {
      try {
        await unwrapVoid(api.DELETE("/pages/{pageId}", { params: { path: { pageId } } }));
        qc.setQueryData<PageSummary[]>(qk.trash(workspaceId), (old) => old?.filter((p) => p.id !== pageId));
        void qc.invalidateQueries({ queryKey: qk.trash(workspaceId) });
        toast.success("Page deleted permanently");
        return true;
      } catch (error) {
        toast.error("Couldn't delete the page", { description: errorMessage(error) });
        return false;
      }
    },
    [qc, workspaceId],
  );

  const copyLink = useCallback(
    async (pageId: string) => {
      const ok = await copyToClipboard(absoluteUrl(pageHref(slug, pageId)));
      if (ok) toast.success("Link copied");
      else toast.error("Couldn't copy the link");
    },
    [slug],
  );

  const exportPage = useCallback(async (pageId: string, title: string) => {
    const toastId = toast.loading("Preparing export…");
    try {
      const res = await fetch(`/api/pages/${pageId}/export`, { credentials: "include" });
      if (!res.ok) throw ApiError.fromResponse(res.status, await res.json().catch(() => undefined));
      const blob = await res.blob();
      const name =
        filenameFromDisposition(res.headers.get("content-disposition")) ??
        `${sanitizeFilename(title || "Untitled")}.zip`;
      downloadBlob(blob, name);
      toast.success("Export downloaded", { id: toastId });
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 501
          ? "Export isn't available on this server yet."
          : errorMessage(error);
      toast.error("Couldn't export the page", { id: toastId, description: message });
    }
  }, []);

  return useMemo(
    () => ({
      createPage,
      rename,
      updateMeta,
      setFavorite,
      archive,
      restore,
      move,
      duplicate,
      purge,
      copyLink,
      exportPage,
    }),
    [createPage, rename, updateMeta, setFavorite, archive, restore, move, duplicate, purge, copyLink, exportPage],
  );
}

export type PageActions = ReturnType<typeof usePageActions>;
