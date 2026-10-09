/**
 * What the editor tells the user about its link to the collab server. Pure so the (fiddly) transitions can
 * be tested without sockets.
 */
export type ConnectionState =
  /** Opening the connection (initial load, or a quick reconnect). */
  | "connecting"
  /** Connected and everything we typed has reached the server. */
  | "synced"
  /** Connected, still sending local changes. */
  | "syncing"
  /** No server connection: edits are kept on this device and merged on reconnect. */
  | "offline"
  /** The server says we may not open this page (anymore). */
  | "no-access"
  /** Something we can't fix by retrying quickly (misconfiguration, expired session). */
  | "error";

export interface ConnectionInputs {
  failure: "no-access" | "error" | null;
  online: boolean;
  wsConnected: boolean;
  authenticated: boolean;
  synced: boolean;
  hasUnsynced: boolean;
  /** False during the grace period after load / after a drop, so brief reconnects don't flash "offline". */
  settled: boolean;
}

export function deriveConnection(i: ConnectionInputs): ConnectionState {
  if (i.failure) return i.failure;
  if (i.wsConnected && i.authenticated && i.synced) return i.hasUnsynced ? "syncing" : "synced";
  if (!i.online) return "offline";
  if (!i.settled) return "connecting";
  return i.wsConnected ? "connecting" : "offline";
}

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  synced: "Saved",
  syncing: "Saving…",
  offline: "Offline: changes are saved on this device",
  "no-access": "No access",
  error: "Can't connect",
};

/** Server rejection reasons (collab/src/auth.ts) → what the client should do about them. */
export type AuthFailureAction = "retry" | "no-access" | "error";

export function classifyAuthFailure(reason: string): AuthFailureAction {
  switch (reason) {
    case "token-expired":
    case "unauthorized":
    case "internal":
      return "retry";
    case "forbidden-page":
    case "forbidden-origin":
    case "invalid-document":
      return "error";
    default:
      return "retry";
  }
}

/** Exponential backoff with equal jitter, capped. `random` is injectable for tests. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}
