"use client";

import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/lib/collab/connection";
import { CONNECTION_LABELS } from "@/lib/collab/connection";
import { useConnection } from "@/components/page/presence";

const DOT: Record<ConnectionState, string> = {
  synced: "bg-success",
  syncing: "bg-warning",
  connecting: "bg-warning",
  offline: "bg-muted-foreground",
  "no-access": "bg-destructive",
  error: "bg-destructive",
};

/** What the dot says. Read-only viewers don't "save" anything, so a healthy connection reads "Live" for them. */
export function connectionLabel(state: ConnectionState, editable: boolean): string {
  if (state === "synced" && !editable) return "Live";
  return CONNECTION_LABELS[state];
}

/**
 * A small status pill for the collaboration link of the open page: connected and saved, saving, reconnecting,
 * offline (edits stay on this device and merge later) or failed. `data-connection` is the machine-readable form.
 */
export function ConnectionIndicator({ editable, className }: { editable: boolean; className?: string }) {
  const state = useConnection();
  if (!state) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-connection={state}
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />
      <span className="truncate">{connectionLabel(state, editable)}</span>
    </span>
  );
}
