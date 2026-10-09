import { generateKeyBetween } from "fractional-indexing";
import type { PageSummary } from "@hostidian/api-types";
import { comparePages } from "./tree";

/** `generateKeyBetween` that never throws on corrupt/colliding neighbours (server value wins anyway). */
export function positionBetween(a: string | null, b: string | null): string {
  try {
    return generateKeyBetween(a, b);
  } catch {
    try {
      return generateKeyBetween(a, null);
    } catch {
      return generateKeyBetween(null, null);
    }
  }
}

export interface PositionTarget {
  afterId?: string | null;
  beforeId?: string | null;
  /** The page being moved (excluded from its own neighbours). */
  excludeId?: string;
}

/**
 * Locally computed fractional position for optimistic ordering. `siblings` are the pages that share
 * the destination parent (any order). Omitting both ids appends, like the move endpoint.
 */
export function computePosition(siblings: readonly PageSummary[], target: PositionTarget = {}): string {
  const ordered = siblings.filter((p) => p.id !== target.excludeId).sort(comparePages);

  if (target.afterId) {
    const i = ordered.findIndex((p) => p.id === target.afterId);
    if (i >= 0) return positionBetween(ordered[i]!.position, ordered[i + 1]?.position ?? null);
  }
  if (target.beforeId) {
    const i = ordered.findIndex((p) => p.id === target.beforeId);
    if (i >= 0) return positionBetween(ordered[i - 1]?.position ?? null, ordered[i]!.position);
  }
  return positionBetween(ordered[ordered.length - 1]?.position ?? null, null);
}
