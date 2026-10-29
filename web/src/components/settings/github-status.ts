import type { GithubConnection } from "@hostidian/api-types";

export interface ConnectionStatus {
  label: string;
  variant: "success" | "warning" | "destructive" | "default";
}

/** One badge for a connection, most important condition first. */
export function connectionStatus(c: Pick<GithubConnection, "enabled" | "lastError" | "backfilled" | "lastSyncedAt">): ConnectionStatus {
  if (!c.enabled) return { label: "Paused", variant: "warning" };
  if (c.lastError) return { label: "Needs attention", variant: "destructive" };
  if (!c.backfilled) return { label: c.lastSyncedAt ? "Importing issues…" : "Starting…", variant: "default" };
  return { label: "Active", variant: "success" };
}

/** What to enter in GitHub → Settings → Webhooks. */
export const WEBHOOK_EVENTS = ["Issues", "Issue comments"] as const;
