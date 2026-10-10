import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { PageDetail, PageSummary } from "@hostidian/api-types";
import { api } from "./client";
import { hasStatus, isNetworkError } from "./error";
import { qk } from "./keys";
import { unwrap } from "./unwrap";
import { ancestorPages, buildTree } from "../tree";

// ------------------------------------------------------------------ instance / session

export const instanceInfoOptions = () =>
  queryOptions({
    queryKey: qk.instance(),
    queryFn: ({ signal }) => unwrap(api.GET("/instance/info", { signal })),
    staleTime: 60_000,
  });

export const meOptions = () =>
  queryOptions({
    queryKey: qk.me(),
    queryFn: ({ signal }) => unwrap(api.GET("/auth/me", { signal })),
    staleTime: 5 * 60_000,
    // A 401 here is an answer ("not signed in"), not something to retry.
    retry: (count, error) => isNetworkError(error) && count < 1,
  });

export const inviteInfoOptions = (token: string) =>
  queryOptions({
    queryKey: qk.invite(token),
    queryFn: ({ signal }) => unwrap(api.GET("/auth/invites/{token}", { params: { path: { token } }, signal })),
    retry: false,
  });

export const sessionsOptions = () =>
  queryOptions({
    queryKey: qk.sessions(),
    queryFn: ({ signal }) => unwrap(api.GET("/auth/sessions", { signal })),
  });

// ------------------------------------------------------------------ workspace data

export const pagesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: qk.pages(workspaceId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/workspaces/{workspaceId}/pages", { params: { path: { workspaceId } }, signal })),
  });

export const favoritesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: qk.favorites(workspaceId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/workspaces/{workspaceId}/favorites", { params: { path: { workspaceId } }, signal })),
  });

export const recentOptions = (workspaceId: string, limit = 15) =>
  queryOptions({
    queryKey: [...qk.recent(workspaceId), limit] as const,
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/workspaces/{workspaceId}/recent", {
          params: { path: { workspaceId }, query: { limit } },
          signal,
        }),
      ),
  });

export const trashOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: qk.trash(workspaceId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/workspaces/{workspaceId}/trash", { params: { path: { workspaceId } }, signal })),
  });

export const graphOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: qk.graph(workspaceId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/workspaces/{workspaceId}/graph", { params: { path: { workspaceId } }, signal })),
    staleTime: 30_000,
  });

export const membersOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: qk.members(workspaceId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/workspaces/{workspaceId}/members", { params: { path: { workspaceId } }, signal })),
  });

export const workspaceInvitesOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: qk.invites(workspaceId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/workspaces/{workspaceId}/invites", { params: { path: { workspaceId } }, signal })),
  });

export const searchOptions = (workspaceId: string, mode: "title" | "full", q: string, limit = 8) =>
  queryOptions({
    queryKey: qk.search(workspaceId, mode, q),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/workspaces/{workspaceId}/search", {
          params: { path: { workspaceId }, query: { q, mode, limit } },
          signal,
        }),
      ),
    staleTime: 15_000,
  });

// ------------------------------------------------------------------ pages

/** Detail built from the cached tree, used while the real `getPage` is loading or when the page only exists locally. */
export function synthesizePageDetail(qc: QueryClient, pageId: string): PageDetail | undefined {
  const lists = qc.getQueriesData<PageSummary[]>({ queryKey: ["workspace"] });
  for (const [key, list] of lists) {
    if (key[2] !== "pages" || !Array.isArray(list)) continue;
    const page = list.find((p) => p.id === pageId);
    if (!page) continue;
    const tree = buildTree(list);
    const favorites = qc.getQueryData<PageSummary[]>(qk.favorites(page.workspaceId));
    return {
      page,
      breadcrumbs: ancestorPages(tree, pageId).map((a) => ({ id: a.id, title: a.title, icon: a.icon })),
      isFavorite: favorites?.some((f) => f.id === pageId) ?? false,
    };
  }
  return undefined;
}

function hasPendingCreate(qc: QueryClient, pageId: string): boolean {
  return qc
    .getMutationCache()
    .findAll({ mutationKey: ["createPage"] })
    .some((m) => m.state.status === "pending" && (m.state.variables as { id?: string } | undefined)?.id === pageId);
}

export const pageDetailOptions = (qc: QueryClient, pageId: string) =>
  queryOptions<PageDetail, Error, PageDetail, ReturnType<typeof qk.page>>({
    queryKey: qk.page(pageId),
    queryFn: async ({ signal }): Promise<PageDetail> => {
      try {
        return await unwrap(api.GET("/pages/{pageId}", { params: { path: { pageId } }, signal }));
      } catch (error) {
        // A page created offline (or still in flight) isn't on the server yet: keep serving the local copy.
        if ((hasStatus(error, 404) || isNetworkError(error)) && hasPendingCreate(qc, pageId)) {
          const local = qc.getQueryData<PageDetail>(qk.page(pageId)) ?? synthesizePageDetail(qc, pageId);
          if (local) return local;
        }
        throw error;
      }
    },
    placeholderData: () => synthesizePageDetail(qc, pageId),
    staleTime: 30_000,
    retry: (count, error) => (hasStatus(error, 404, 403) ? false : count < 2),
  });

export const pagePermissionsOptions = (pageId: string) =>
  queryOptions({
    queryKey: qk.pagePermissions(pageId),
    queryFn: ({ signal }) => unwrap(api.GET("/pages/{pageId}/permissions", { params: { path: { pageId } }, signal })),
    retry: (count, error) => (hasStatus(error, 403, 404) ? false : count < 2),
  });

export const shareLinksOptions = (pageId: string) =>
  queryOptions({
    queryKey: qk.shares(pageId),
    queryFn: ({ signal }) => unwrap(api.GET("/pages/{pageId}/shares", { params: { path: { pageId } }, signal })),
    retry: (count, error) => (hasStatus(error, 403, 404, 501) ? false : count < 2),
  });

// ------------------------------------------------------------------ admin

export const adminUsersOptions = () =>
  queryOptions({
    queryKey: qk.adminUsers(),
    queryFn: ({ signal }) => unwrap(api.GET("/admin/users", { signal })),
  });

export const adminSettingsOptions = () =>
  queryOptions({
    queryKey: qk.adminSettings(),
    queryFn: ({ signal }) => unwrap(api.GET("/admin/settings", { signal })),
  });

// ------------------------------------------------------------------ access tokens (MCP / agents)

export const apiTokensKey = ["auth", "tokens"] as const;

export const apiTokensOptions = () =>
  queryOptions({
    queryKey: apiTokensKey,
    queryFn: ({ signal }) => unwrap(api.GET("/auth/tokens", { signal })),
  });
