"use client";

import { useCallback, useEffect, useState } from "react";
import { readStringArray, STORAGE_KEYS, writeJSON } from "@/lib/storage";

const MAX_PERSISTED = 500;

/** Expanded page ids, persisted per user + workspace. Key the consuming component by workspace id. */
export function useExpandedIds(userId: string, workspaceId: string) {
  const key = STORAGE_KEYS.treeExpanded(userId, workspaceId);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(readStringArray(key)));

  useEffect(() => {
    writeJSON(key, [...expanded].slice(-MAX_PERSISTED));
  }, [expanded, key]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const expand = useCallback((ids: readonly string[]) => {
    setExpanded((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const collapse = useCallback((id: string) => {
    setExpanded((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return { expanded, toggle, expand, collapse };
}

/** Which sidebar sections (favorites/workspace/private/shared) the user collapsed. */
export function useCollapsedSections(userId: string) {
  const key = STORAGE_KEYS.sectionsCollapsed(userId);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readStringArray(key)));

  useEffect(() => {
    writeJSON(key, [...collapsed]);
  }, [collapsed, key]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
