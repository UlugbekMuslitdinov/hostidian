import type { CommentThread } from "@hostidian/api-types";

/**
 * Pure logic behind block-anchored comments (conventions §10): which thread hangs off which block, which
 * threads lost their block, and how to lay out the margin badges. No React, no DOM.
 */

export const MAX_QUOTE_LENGTH = 500;

export interface ThreadView {
  thread: CommentThread;
  resolved: boolean;
  /** The block the thread was anchored to no longer exists in the document. */
  detached: boolean;
  /** Created locally and not yet confirmed by the server. */
  pending: boolean;
}

export interface ThreadGroups {
  /** Threads to show in the panel, in document order (detached ones last). */
  visible: ThreadView[];
  /** Visible, attached threads by block id, in creation order. */
  byBlock: Map<string, ThreadView[]>;
  detached: ThreadView[];
  openCount: number;
  resolvedCount: number;
}

export const isPendingThread = (thread: CommentThread) => thread.id.startsWith("tmp-");

/** Block ids of a BlockNote document (any depth), in document order. */
export function collectBlockIds(blocks: ReadonlyArray<{ id: string; children?: ReadonlyArray<unknown> }>): string[] {
  const ids: string[] = [];
  const walk = (list: ReadonlyArray<{ id?: unknown; children?: ReadonlyArray<unknown> }>) => {
    for (const block of list) {
      if (typeof block.id === "string") ids.push(block.id);
      if (Array.isArray(block.children)) walk(block.children as Array<{ id?: unknown; children?: ReadonlyArray<unknown> }>);
    }
  };
  walk(blocks);
  return ids;
}

/**
 * Split threads into what the panel shows and what the margin shows.
 *
 * `blockOrder === null` means the editor hasn't reported its blocks yet (loading, or a local copy that is
 * still empty): nothing is flagged as detached then, otherwise every thread would flash "detached" on load.
 */
export function groupThreads(
  threads: readonly CommentThread[],
  blockOrder: readonly string[] | null,
  options: { showResolved: boolean },
): ThreadGroups {
  const position = blockOrder ? new Map(blockOrder.map((id, index) => [id, index] as const)) : null;
  const views: ThreadView[] = threads.map((thread) => ({
    thread,
    resolved: Boolean(thread.resolvedAt),
    detached: position !== null && !position.has(thread.blockId),
    pending: isPendingThread(thread),
  }));

  const openCount = views.filter((v) => !v.resolved).length;
  const resolvedCount = views.length - openCount;
  const shown = views.filter((v) => options.showResolved || !v.resolved);

  const byCreated = (a: ThreadView, b: ThreadView) =>
    a.thread.createdAt.localeCompare(b.thread.createdAt) || a.thread.id.localeCompare(b.thread.id);
  const attached = shown.filter((v) => !v.detached);
  const detached = shown.filter((v) => v.detached).sort(byCreated);

  attached.sort((a, b) => {
    if (position) {
      const delta = (position.get(a.thread.blockId) ?? 0) - (position.get(b.thread.blockId) ?? 0);
      if (delta !== 0) return delta;
    } else if (a.thread.blockId !== b.thread.blockId) {
      return a.thread.createdAt.localeCompare(b.thread.createdAt);
    }
    return byCreated(a, b);
  });

  const byBlock = new Map<string, ThreadView[]>();
  for (const view of attached) {
    const list = byBlock.get(view.thread.blockId);
    if (list) list.push(view);
    else byBlock.set(view.thread.blockId, [view]);
  }
  return { visible: [...attached, ...detached], byBlock, detached, openCount, resolvedCount };
}

/** Number shown on a margin badge: comments in unresolved threads, or all of them if every thread is resolved. */
export function badgeCount(views: readonly ThreadView[]): number {
  const open = views.filter((v) => !v.resolved);
  const counted = open.length > 0 ? open : views;
  return counted.reduce((sum, v) => sum + v.thread.comments.length, 0);
}

export const badgeIsResolved = (views: readonly ThreadView[]) => views.length > 0 && views.every((v) => v.resolved);

/** Whitespace-collapsed, length-capped text for the quote shown above a thread. */
export function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The text stored with a new thread: what the user selected, else the block's text. */
export function quoteFor(selectedText: string, blockText: string): string {
  const chosen = selectedText.trim() ? selectedText : blockText;
  return snippet(chosen, MAX_QUOTE_LENGTH);
}

export interface BadgeSlot {
  blockId: string;
  /** Top of the block in the container's coordinates. */
  top: number;
}

/**
 * Nudge badges down so two small blocks (or two neighbouring threads) never overlap. Input order is
 * irrelevant; the result is sorted by top.
 */
export function layoutBadges(slots: readonly BadgeSlot[], badgeHeight: number, gap = 4): BadgeSlot[] {
  const sorted = [...slots].sort((a, b) => a.top - b.top || a.blockId.localeCompare(b.blockId));
  let floor = Number.NEGATIVE_INFINITY;
  return sorted.map((slot) => {
    const top = Math.max(slot.top, floor);
    floor = top + badgeHeight + gap;
    return { blockId: slot.blockId, top };
  });
}
