"use client";

import { useMediaQuery } from "@/hooks/use-media-query";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CommentsPanel } from "./comments-panel";
import { useComments } from "./comments-context";

/**
 * Where the comments panel lives: a sticky right column on wide screens, a slide-over sheet below `lg`.
 * Nothing is rendered when comments aren't available/visible to the caller.
 */
export function CommentsDock() {
  const comments = useComments();
  const wide = useMediaQuery("(min-width: 1024px)", true);

  if (!comments?.available) return null;

  if (wide) {
    if (!comments.panelOpen) return null;
    return (
      <aside className="sticky top-0 hidden h-dvh w-[340px] shrink-0 border-l lg:block" aria-label="Comments">
        <CommentsPanel />
      </aside>
    );
  }

  return (
    <Sheet open={comments.panelOpen} onOpenChange={comments.setPanelOpen}>
      <SheetContent side="right" className="w-[min(92vw,400px)] p-0">
        <SheetTitle className="sr-only">Comments</SheetTitle>
        <SheetDescription className="sr-only">Threads on this page</SheetDescription>
        <CommentsPanel />
      </SheetContent>
    </Sheet>
  );
}
