import type { EffectiveRole, PageRole, WorkspaceRole } from "@hostidian/api-types";

/**
 * Client-side mirror of docs/conventions.md §3. These helpers only decide what UI to *offer*;
 * the Go resolver remains the single source of truth and every call is re-checked server-side.
 */

export type AnyPageRole = PageRole | EffectiveRole | "none";

const PAGE_ROLE_ORDER: Record<AnyPageRole, number> = {
  none: 0,
  view: 1,
  comment: 2,
  edit: 3,
  full: 4,
};

export const PAGE_ROLES: readonly PageRole[] = ["view", "comment", "edit", "full"];

export const PAGE_ROLE_LABELS: Record<AnyPageRole, string> = {
  none: "No access",
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
  full: "Full access",
};

export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

export function roleAtLeast(role: AnyPageRole | null | undefined, min: AnyPageRole): boolean {
  return PAGE_ROLE_ORDER[role ?? "none"] >= PAGE_ROLE_ORDER[min];
}

export function maxRole(a: AnyPageRole, b: AnyPageRole): AnyPageRole {
  return PAGE_ROLE_ORDER[a] >= PAGE_ROLE_ORDER[b] ? a : b;
}

export const canView = (role: AnyPageRole | null | undefined) => roleAtLeast(role, "view");
export const canComment = (role: AnyPageRole | null | undefined) => roleAtLeast(role, "comment");
/** Edit content, title, icon, cover; move children; upload. */
export const canEdit = (role: AnyPageRole | null | undefined) => roleAtLeast(role, "edit");
/** Share, manage permissions, archive/delete, change visibility. */
export const canShare = (role: AnyPageRole | null | undefined) => roleAtLeast(role, "full");
export const canArchive = canShare;
export const canManagePermissions = canShare;
export const canChangeVisibility = (role: AnyPageRole | null | undefined, isRoot: boolean) =>
  isRoot && roleAtLeast(role, "full");

// ------------------------------------------------------------------ workspace level

export const canManageWorkspace = (role: WorkspaceRole | null | undefined) => role === "owner" || role === "admin";
export const canDeleteWorkspace = (role: WorkspaceRole | null | undefined) => role === "owner";
export const canManageMembers = canManageWorkspace;
export const canInviteMembers = canManageWorkspace;
/** Guests only see pages shared with them; they get no workspace-wide tree actions. */
export const canCreateTopLevelPage = (role: WorkspaceRole | null | undefined) =>
  role === "owner" || role === "admin" || role === "member";

/** Which workspace roles `actor` may assign to someone else (conventions: only owners grant/revoke owner). */
export function assignableWorkspaceRoles(actor: WorkspaceRole | null | undefined): WorkspaceRole[] {
  if (actor === "owner") return ["owner", "admin", "member", "guest"];
  if (actor === "admin") return ["admin", "member", "guest"];
  return [];
}

/** May `actor` change/remove `target`'s membership? Admins cannot touch owners. */
export function canModifyMember(actor: WorkspaceRole | null | undefined, target: WorkspaceRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}
