"use client";

import { useEffect, useRef } from "react";
import { usePageActions } from "@/hooks/use-page-actions";
import { useAppNavigate } from "@/lib/nav";
import { canCreateTopLevelPage } from "@/lib/permissions";
import { isTypingTarget, workspaceHref } from "@/lib/utils";
import { useOptionalWorkspace, useWorkspace } from "@/lib/workspace";
import { useAppUI } from "./app-ui";

/** App-wide keyboard shortcuts: ⌘K palette, ⌘N new page, ⌘\ sidebar, and `g h` / `g t` / `g s` navigation. */
export function GlobalShortcuts() {
  const ws = useOptionalWorkspace();
  if (!ws) return <NoWorkspaceShortcuts />;
  return <WorkspaceShortcuts />;
}

function NoWorkspaceShortcuts() {
  const ui = useAppUI();
  useShortcutListener({ palette: () => ui.setPaletteOpen(true), sidebar: ui.toggleSidebar });
  return null;
}

function WorkspaceShortcuts() {
  const ui = useAppUI();
  const navigate = useAppNavigate();
  const { workspace, role } = useWorkspace();
  const actions = usePageActions();

  useShortcutListener({
    palette: () => ui.setPaletteOpen(!ui.paletteOpen),
    sidebar: ui.toggleSidebar,
    newPage: canCreateTopLevelPage(role) ? () => actions.createPage({ parentId: null }) : undefined,
    go: (key) => {
      const base = workspaceHref(workspace.slug);
      if (key === "h") navigate(base);
      else if (key === "t") navigate(`${base}/trash`);
      else if (key === "s") navigate("/settings");
    },
  });
  return null;
}

interface Handlers {
  palette: () => void;
  sidebar: () => void;
  newPage?: () => void;
  go?: (key: string) => void;
}

function useShortcutListener(handlers: Handlers) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    let goUntil = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      const h = ref.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && !e.altKey && key === "k") {
        e.preventDefault();
        h.palette();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (e.key === "\\" || e.code === "Backslash")) {
        e.preventDefault();
        h.sidebar();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && key === "n" && h.newPage) {
        // Browsers reserve ⌘N in a normal tab; this works in the installed PWA.
        e.preventDefault();
        h.newPage();
        return;
      }

      if (mod || e.altKey || isTypingTarget(e.target) || e.repeat) return;
      if (Date.now() < goUntil && h.go && ["h", "t", "s"].includes(key)) {
        goUntil = 0;
        e.preventDefault();
        h.go(key);
        return;
      }
      if (key === "g") goUntil = Date.now() + 1200;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
