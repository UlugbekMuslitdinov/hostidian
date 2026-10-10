"use client";

import { useEffect, useRef } from "react";
import { usePageActions } from "@/hooks/use-page-actions";
import { canCreateTopLevelPage } from "@/lib/permissions";
import { useWorkspace } from "@/lib/workspace";

/** Value of `?action=` on the manifest shortcuts (app/manifest.ts). */
export const NEW_PAGE_ACTION = "new-page";

/** The `?action=` a launch URL asks for, or null. Pure. */
export function launchAction(search: string): string | null {
  return new URLSearchParams(search).get("action");
}

/**
 * Runs the action of an app-icon shortcut ("New page") once the session and workspace are known. The root route
 * redirects to the workspace and drops the query string, so the parameter is read on mount, before that happens.
 */
export function LaunchActions() {
  const actions = usePageActions();
  const { role } = useWorkspace();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (launchAction(window.location.search) === NEW_PAGE_ACTION && canCreateTopLevelPage(role)) {
      actions.createPage({ parentId: null });
    }
  }, [actions, role]);

  return null;
}
