import type { PresenceUser } from "@/components/page/presence";

/**
 * Pure helpers over Yjs awareness. The collab server stamps every state's `user` from the verified JWT
 * (`{id, name, color}`), so peers can't impersonate each other; we still validate shapes defensively
 * because the colour ends up in inline CSS.
 */

const SAFE_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const FALLBACK_PRESENCE_COLOR = "#8a8a85";

export function safeColor(color: unknown): string {
  return typeof color === "string" && SAFE_COLOR_RE.test(color) ? color : FALLBACK_PRESENCE_COLOR;
}

type AwarenessStates = ReadonlyMap<number, Record<string, unknown>>;

/**
 * Everyone else on the page, one entry per user (several tabs/devices of the same person collapse into one
 * avatar), excluding the local user, ordered by name so the avatar stack doesn't reshuffle as cursors move.
 */
export function presenceFromStates(
  states: AwarenessStates,
  selfClientId: number,
  selfUserId: string,
): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const user = state?.user;
    if (typeof user !== "object" || user === null) continue;
    const { id, name, color } = user as Record<string, unknown>;
    if (typeof id !== "string" || !id || id === selfUserId) continue;
    if (typeof name !== "string" || !name.trim()) continue;
    if (!byUser.has(id)) byUser.set(id, { id, name: name.slice(0, 80), color: safeColor(color) });
  }
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
