"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { quoteFor } from "@/components/comments/anchoring";
import { blockText } from "@/components/comments/block-text";
import { useComments } from "@/components/comments/comments-context";
import type { HEditor } from "./editor-types";

const BUTTON = 24;
/** Grace period for the pointer to cross the gap between the text and the button before it disappears. */
const HIDE_DELAY_MS = 250;

interface Target {
  blockId: string;
  top: number;
}

/**
 * The comment button for editors that are read-only. BlockNote's own side menu is wired to `isEditable` and never
 * appears on a read-only editor, but a `comment`-role user must still be able to start a thread (conventions §3,
 * §10). This reproduces the one part of it that matters: a button next to the hovered block (or, on touch screens,
 * the last tapped one). Editable editors keep BlockNote's side menu (see `CommentSideMenu`).
 */
export function ReadOnlyCommentOverlay({ editor, wrapperRef }: { editor: HEditor; wrapperRef: RefObject<HTMLElement | null> }) {
  const comments = useComments();
  const [target, setTarget] = useState<Target | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canComment = Boolean(comments?.canComment);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !canComment) return;

    const cancelHide = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
    const scheduleHide = () => {
      cancelHide();
      hideTimer.current = setTimeout(() => setTarget(null), HIDE_DELAY_MS);
    };

    const point = (event: PointerEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest("[data-comment-overlay]")) {
        cancelHide();
        return;
      }
      const outer = element?.closest<HTMLElement>(".bn-block-outer[data-id]");
      const blockId = outer?.getAttribute("data-id");
      // A block's own content row (its children are separate blocks with their own buttons).
      const content = outer?.querySelector<HTMLElement>(".bn-block-content");
      if (!outer || !blockId || !content) {
        scheduleHide();
        return;
      }
      cancelHide();
      const rect = content.getBoundingClientRect();
      const top = rect.top - wrapper.getBoundingClientRect().top + Math.max(0, (Math.min(rect.height, 30) - BUTTON) / 2);
      setTarget((prev) => (prev && prev.blockId === blockId && Math.abs(prev.top - top) < 1 ? prev : { blockId, top }));
    };

    wrapper.addEventListener("pointermove", point);
    // Touch has no hover: a tap on a block selects it as the target.
    wrapper.addEventListener("pointerdown", point);
    wrapper.addEventListener("pointerleave", scheduleHide);
    return () => {
      wrapper.removeEventListener("pointermove", point);
      wrapper.removeEventListener("pointerdown", point);
      wrapper.removeEventListener("pointerleave", scheduleHide);
      cancelHide();
    };
  }, [wrapperRef, canComment]);

  if (!comments || !canComment || !target) return null;

  return (
    <button
      type="button"
      data-comment-overlay=""
      aria-label="Add comment"
      title="Add comment"
      style={{ top: target.top, width: BUTTON, height: BUTTON }}
      className="absolute right-1 z-10 flex items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground md:-left-8 md:right-auto md:border-transparent md:bg-transparent md:shadow-none"
      onClick={(event) => {
        event.preventDefault();
        const block = editor.getBlock(target.blockId);
        if (!block) return;
        comments.startThread({
          blockId: block.id,
          quote: quoteFor(editor.getSelectedText(), blockText(block)),
        });
      }}
    >
      <MessageSquarePlus size={18} aria-hidden="true" />
    </button>
  );
}
