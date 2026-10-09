import type { Me, PageSummary, User, WorkspaceMembership } from "@hostidian/api-types";

let counter = 0;

export function makePage(overrides: Partial<PageSummary> = {}): PageSummary {
  counter += 1;
  const id = overrides.id ?? `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`;
  return {
    id,
    workspaceId: "ws-1",
    parentId: null,
    title: `Page ${counter}`,
    icon: null,
    cover: null,
    position: "a0",
    visibility: "workspace",
    role: "full",
    createdBy: "user-1",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    archivedAt: null,
    ...overrides,
  };
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    avatarColor: "#64b5f6",
    isInstanceAdmin: false,
    hasPassword: true,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeMembership(overrides: Partial<WorkspaceMembership> = {}): WorkspaceMembership {
  return {
    workspace: { id: "ws-1", name: "Acme", slug: "acme", icon: null, createdAt: "2026-01-01T00:00:00Z" },
    role: "owner",
    ...overrides,
  };
}

export function makeMe(overrides: Partial<Me> = {}): Me {
  return { user: makeUser(), workspaces: [makeMembership()], ...overrides };
}
