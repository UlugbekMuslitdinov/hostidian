"use client";

import { useEffect } from "react";

/** Client pages can't export `metadata`; set the tab title imperatively. */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · Hostidian`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
