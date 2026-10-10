"use client";

import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { SidebarButton } from "@/components/sidebar/sidebar-link";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useOfflineRuntime, usePersistStatus, useSyncState } from "@/lib/offline/context";
import { readPrefetchRecords } from "@/lib/offline/prefetch";
import type { SyncKind } from "@/lib/offline/sync-status";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { describeSync, plural } from "./sync-copy";

function StatusIcon({ kind }: { kind: SyncKind }) {
  switch (kind) {
    case "offline":
      return <CloudOff className="!text-warning" />;
    case "syncing":
      return <RefreshCw className="animate-spin motion-reduce:animate-none" />;
    case "error":
      return <TriangleAlert className="!text-destructive" />;
    default:
      return (
        <span aria-hidden="true" className="grid size-[18px] place-items-center">
          <span className="size-2 rounded-full bg-success" />
        </span>
      );
  }
}

/**
 * Sidebar-footer indicator: online / offline / syncing (with the number of queued changes) / sync problem.
 * Opens a popover with the details and a Retry button.
 */
export function ConnectionStatus() {
  const { kind, pending, error } = useSyncState();
  const runtime = useOfflineRuntime();
  const persist = usePersistStatus();
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const copy = describeSync(kind, pending, error?.message);
  // Pages whose documents are on this device (bookkeeping of the prefetcher). Read when the popover opens.
  const offlinePages = open ? Object.keys(readPrefetchRecords(user.id)).length : 0;

  const retry = async () => {
    setRetrying(true);
    try {
      await runtime.retrySync();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <SidebarButton
          icon={<StatusIcon kind={kind} />}
          data-testid="connection-status"
          data-sync-state={kind}
          aria-label={`Connection status: ${copy.label}`}
          className={cn(kind === "error" && "text-destructive")}
        >
          {copy.label}
        </SidebarButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
        <div className="space-y-2.5 text-sm" role="status" aria-live="polite">
          <p className="font-medium">{copy.label}</p>
          <p className="text-muted-foreground">{copy.detail}</p>
          {pending > 0 && kind !== "syncing" ? (
            <p className="text-muted-foreground">{plural(pending, "change")} queued on this device.</p>
          ) : null}
          {offlinePages > 0 ? (
            <p className="text-muted-foreground">{plural(offlinePages, "page")} available offline.</p>
          ) : null}
          {persist.state !== "ok" ? (
            <p className="text-warning">
              {persist.state === "quota"
                ? "Offline storage is almost full, so only the most important data is kept."
                : "Offline storage isn't available in this browser mode; changes made offline may be lost on reload."}
            </p>
          ) : null}
          {kind === "offline" || kind === "error" ? (
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
                <RefreshCw className={cn(retrying && "animate-spin")} aria-hidden="true" />
                {retrying ? "Checking…" : "Retry now"}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
