"use client";

import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useSyncState } from "@/lib/offline/context";
import type { SyncKind } from "@/lib/offline/sync-status";
import { cn } from "@/lib/utils";
import { bannerText } from "./sync-copy";

export interface BannerState {
  kind: Exclude<SyncKind, "online">;
  text: string;
}

/** The banner to show for the current connectivity, or null when there is nothing to say. */
export function useBannerState(): BannerState | null {
  const { kind, pending } = useSyncState();
  if (kind === "online") return null;
  const text = bannerText(kind, pending);
  return text ? { kind, text } : null;
}

const TONES: Record<BannerState["kind"], string> = {
  offline: "bg-warning/15 text-foreground",
  syncing: "bg-primary/10 text-foreground",
  error: "bg-destructive/15 text-foreground",
};

/**
 * Slim status strip above the page (app-shell.tsx decides when: always on phones, on desktop only while the
 * sidebar, home of the connection indicator, is collapsed). It owns the top safe-area inset while visible, so the
 * page header below it must not add the inset a second time (see `--safe-top` in app-shell.tsx / globals.css).
 */
export function OfflineBanner({ banner }: { banner: BannerState }) {
  const Icon = banner.kind === "offline" ? CloudOff : banner.kind === "syncing" ? RefreshCw : TriangleAlert;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-sync-state={banner.kind}
      className={cn("shrink-0 px-safe", TONES[banner.kind])}
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="flex min-h-7 items-center justify-center gap-1.5 px-3 py-1 text-center text-xs font-medium">
        <Icon className={cn("size-3.5 shrink-0", banner.kind === "syncing" && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
        <span>{banner.text}</span>
      </div>
    </div>
  );
}
