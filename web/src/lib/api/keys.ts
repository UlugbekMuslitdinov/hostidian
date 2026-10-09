/**
 * Query-key factory. Keys are hierarchical (`["workspace", id, ...]`, `["page", id, ...]`) so a whole
 * workspace or page can be invalidated with one prefix.
 */
export const qk = {
  instance: () => ["instance"] as const,
  me: () => ["me"] as const,
  invite: (token: string) => ["invite", token] as const,
  sessions: () => ["sessions"] as const,

  workspace: (workspaceId: string) => ["workspace", workspaceId] as const,
  members: (workspaceId: string) => ["workspace", workspaceId, "members"] as const,
  invites: (workspaceId: string) => ["workspace", workspaceId, "invites"] as const,
  pages: (workspaceId: string) => ["workspace", workspaceId, "pages"] as const,
  trash: (workspaceId: string) => ["workspace", workspaceId, "trash"] as const,
  favorites: (workspaceId: string) => ["workspace", workspaceId, "favorites"] as const,
  recent: (workspaceId: string) => ["workspace", workspaceId, "recent"] as const,
  search: (workspaceId: string, mode: "title" | "full", q: string) =>
    ["workspace", workspaceId, "search", mode, q] as const,
  graph: (workspaceId: string) => ["workspace", workspaceId, "graph"] as const,

  page: (pageId: string) => ["page", pageId] as const,
  pagePermissions: (pageId: string) => ["page", pageId, "permissions"] as const,
  pageContent: (pageId: string) => ["page", pageId, "content"] as const,
  backlinks: (pageId: string) => ["page", pageId, "backlinks"] as const,
  comments: (pageId: string) => ["page", pageId, "comments"] as const,
  shares: (pageId: string) => ["page", pageId, "shares"] as const,

  adminUsers: () => ["admin", "users"] as const,
  adminSettings: () => ["admin", "settings"] as const,
} as const;
