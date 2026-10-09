"use client";

import { Check, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { HEditor } from "@/components/editor/editor-types";
import { badgeCount, badgeIsResolved, layoutBadges } from "./anchoring";
import { useComments } from "./comments-context";

/** Vertical offset of every block (by id) relative to the editor wrapper, recomputed as the document changes. */
function useBlockTops(editor: HEditor, wrapperRef: RefObject<HTMLElement | null>): Map<string, number> {
  const [tops, setTops] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let frame = 0;
    const compute = () => {
      frame = 0;
      const base = wrapper.getBoundingClientRect().top;
      const next = new Map<string, number>();
      for (const element of wrapper.querySelectorAll<HTMLElement>("[data-id]")) {
        const id = element.getAttribute("data-id");
        if (!id || next.has(id)) continue;
        next.set(id, element.getBoundingClientRect().top - base);
      }
      setTops((prev) => {
        if (prev.size === next.size && [...next].every(([id, top]) => Math.abs((prev.get(id) ?? -1) - top) < 1)) {
          return prev;
        }
        return next;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(compute);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(wrapper, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(wrapper);
    window.addEventListener("resize", schedule);
    compute();
    return () => {
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, wrapperRef]);

  return tops;
}

/**
 * Comment-count badges in the page's right margin, one per block that has threads. Positions are derived from
 * the rendered blocks (so they track edits) and nudged apart so neighbouring badges never overlap. Hidden on
 * small screens, where the panel is the entry point.
 */
export function ThreadBadges({ editor, wrapperRef }: { editor: HEditor; wrapperRef: RefObject<HTMLElement | null> }) {
  const comments = useComments();
  const tops = useBlockTops(editor, wrapperRef);
  const containerRef = useRef<HTMLDivElement>(null);

  if (!comments || !comments.available) return null;

  const slots = [...comments.groups.byBlock.entries()].flatMap(([blockId, views]) => {
    const top = tops.get(blockId);
    if (top === undefined || views.length === 0) return [];
    return [[blockId, views, top] as const];
  });
  if (slots.length === 0) return null;

  const laid = layoutBadges(
    slots.map(([blockId, , top]) => ({ blockId, top })),
    24,
    4,
  );
  const byId = new Map(slots.map(([blockId, views]) => [blockId, views]));

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden="true">
      {laid.map((slot) => {
        const views = byId.get(slot.blockId);
        if (!views) return null;
        const count = badgeCount(views);
        const resolved = badgeIsResolved(views);
        const active = views.some((view) => view.thread.id === comments.activeThreadId);
        return (
          <button
            key={slot.blockId}
            type="button"
            style={{ top: slot.top, right: "-2.25rem" }}
            onClick={() => comments.selectThread(views[0]!.thread.id)}
            aria-label={`${count} comment${count === 1 ? "" : "s"} on this block`}
            className={cn(
              "pointer-events-auto absolute flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full border bg-background px-1.5 text-[11px] font-medium shadow-sm transition-colors",
              active ? "border-primary text-primary" : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {resolved ? <Check className="size-3" aria-hidden="true" /> : <MessageSquare className="size-3" aria-hidden="true" />}
            {count}
          </button>
        );
      })}
    </div>
  );
}
