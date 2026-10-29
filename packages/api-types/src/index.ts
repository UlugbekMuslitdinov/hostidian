// Re-exports of the types generated from api/openapi.yaml.
// Regenerate with: pnpm gen:api   (never edit schema.d.ts by hand)
import type { components, paths } from "./schema";

export type { components, paths };
export type Schemas = components["schemas"];

export type ApiError = Schemas["Error"];
export type User = Schemas["User"];
export type UserRef = Schemas["UserRef"];
export type MemberUser = Schemas["MemberUser"];
export type Me = Schemas["Me"];
export type Workspace = Schemas["Workspace"];
export type WorkspaceMembership = Schemas["WorkspaceMembership"];
export type WorkspaceRole = Schemas["WorkspaceRole"];
export type Member = Schemas["Member"];
export type Invite = Schemas["Invite"];
export type InviteRole = Schemas["InviteRole"];
export type AdminUser = Schemas["AdminUser"];
export type TokenScope = Schemas["TokenScope"];
export type ApiToken = Schemas["ApiToken"];
export type CreatedApiToken = Schemas["CreatedApiToken"];
export type AdminCreatedUser = Schemas["AdminCreatedUser"];
export type PageSummary = Schemas["PageSummary"];
export type PageDetail = Schemas["PageDetail"];
export type PageRef = Schemas["PageRef"];
export type PageRole = Schemas["PageRole"];
export type EffectiveRole = Schemas["EffectiveRole"];
export type Visibility = Schemas["Visibility"];
export type PagePermissions = Schemas["PagePermissions"];
export type CollabToken = Schemas["CollabToken"];
export type GithubConnection = Schemas["GithubConnection"];
export type GithubIssueRef = Schemas["GithubIssueRef"];
export type GithubIssueState = Schemas["GithubIssueState"];
export type PageGithub = Schemas["PageGithub"];
export type CommentThread = Schemas["CommentThread"];
export type Comment = Schemas["Comment"];
export type ShareLink = Schemas["ShareLink"];
export type PublicPage = Schemas["PublicPage"];
export type SearchResult = Schemas["SearchResult"];
export type Graph = Schemas["Graph"];
export type Attachment = Schemas["Attachment"];
export type ImportJob = Schemas["ImportJob"];
export type InstanceInfo = Schemas["InstanceInfo"];
export type InstanceSettings = Schemas["InstanceSettings"];

/** SSE envelope — see docs/conventions.md §5 */
export type WorkspaceEventType =
  | "page.created"
  | "page.updated"
  | "page.moved"
  | "page.archived"
  | "page.restored"
  | "page.deleted"
  | "permissions.changed"
  | "comment.created"
  | "comment.updated"
  | "comment.resolved"
  | "comment.deleted"
  | "member.changed";

export interface WorkspaceEvent<T = unknown> {
  type: WorkspaceEventType;
  workspaceId: string;
  pageId?: string;
  actorId?: string;
  at: string;
  data?: T;
}
