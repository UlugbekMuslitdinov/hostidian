import { readStorage, writeStorage } from "@/lib/storage";

/**
 * The page the user was last looking at in a workspace: what "Local graph" centres on when the graph is opened
 * from the sidebar rather than from a page.
 */
const key = (workspaceId: string) => `hostidian:lastPage:${workspaceId}`;

export function rememberLastPage(workspaceId: string, pageId: string): void {
  writeStorage(key(workspaceId), pageId);
}

export function recallLastPage(workspaceId: string): string | null {
  return readStorage(key(workspaceId));
}
