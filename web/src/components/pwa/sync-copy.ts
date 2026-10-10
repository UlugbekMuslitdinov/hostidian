import type { SyncKind } from "@/lib/offline/sync-status";

/** User-facing wording for the connectivity states, kept pure so the indicator, banner and tests agree. */

export const plural = (count: number, one: string, many: string = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export interface SyncCopy {
  /** Short label for the sidebar row. */
  label: string;
  /** One sentence for the popover / banner. */
  detail: string;
}

export function describeSync(kind: SyncKind, pending: number, errorMessage?: string): SyncCopy {
  switch (kind) {
    case "offline":
      return {
        label: pending > 0 ? `Offline · ${plural(pending, "change")} saved` : "Offline",
        detail:
          pending > 0
            ? `You're offline. ${plural(pending, "change")} will sync when you reconnect; page text is saved on this device.`
            : "You're offline. Cached pages stay readable and editable; everything syncs when you reconnect.",
      };
    case "syncing":
      return {
        label: `Syncing ${plural(pending, "change")}…`,
        detail: `Sending ${plural(pending, "change")} to the server.`,
      };
    case "error":
      return {
        label: "Sync problem",
        detail: errorMessage ? `A change couldn't be saved: ${errorMessage}` : "A change couldn't be saved to the server.",
      };
    default:
      return { label: "Online", detail: "Connected. Changes are saved to the server as you make them." };
  }
}

/** The slim banner text (shorter than the popover detail). */
export function bannerText(kind: SyncKind, pending: number): string | null {
  switch (kind) {
    case "offline":
      return pending > 0
        ? `Offline · ${plural(pending, "change")} will sync when you reconnect`
        : "You're offline · changes are saved on this device";
    case "syncing":
      return `Syncing ${plural(pending, "change")}…`;
    case "error":
      return "Some changes couldn't be synced";
    default:
      return null;
  }
}
