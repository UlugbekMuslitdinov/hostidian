"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Workspace, WorkspaceMembership, WorkspaceRole } from "@hostidian/api-types";

export interface WorkspaceValue {
  workspace: Workspace;
  role: WorkspaceRole;
  memberships: WorkspaceMembership[];
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceValue | null; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** The workspace selected by the URL (or the last-used one outside /w/[slug]); null when the user has none. */
export function useOptionalWorkspace(): WorkspaceValue | null {
  return useContext(WorkspaceContext);
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used where a workspace is selected");
  return ctx;
}

/**
 * Pick the workspace for a slug, else the last-used one, else the first. An unknown slug falls back too,
 * so the sidebar stays usable; the /w/[slug] layout is what shows the "not found" state.
 */
export function resolveWorkspace(
  memberships: readonly WorkspaceMembership[],
  slug: string | undefined,
  lastUsedSlug: string | null,
): WorkspaceMembership | undefined {
  return (
    (slug ? memberships.find((m) => m.workspace.slug === slug) : undefined) ??
    memberships.find((m) => m.workspace.slug === lastUsedSlug) ??
    memberships[0]
  );
}
