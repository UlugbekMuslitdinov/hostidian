"use client";

import type { EffectiveRole } from "@hostidian/api-types";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { hasStatus } from "@/lib/api/error";
import { canComment, canView } from "@/lib/permissions";
import { groupThreads, type ThreadGroups } from "./anchoring";
import { useCommentActions, useCommentThreads, type CommentActions } from "./use-comments";
import type { CommentThread } from "@hostidian/api-types";
import { GITHUB_THREAD_BLOCK_ID } from "@/lib/github";

export interface ComposerTarget {
  blockId: string;
  quote: string;
}

export interface CommentsContextValue {
  pageId: string;
  /** Server supports comments and the caller may read them. */
  available: boolean;
  canComment: boolean;
  threads: CommentThread[];
  groups: ThreadGroups;
  isLoading: boolean;
  isError: boolean;
  actions: CommentActions;

  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  showResolved: boolean;
  setShowResolved(show: boolean): void;
  activeThreadId: string | null;
  /** Open the panel on a thread and scroll its block into view. */
  selectThread(threadId: string | null): void;
  composer: ComposerTarget | null;
  /** Start a new thread on a block (opens the panel with a composer). */
  startThread(target: ComposerTarget): void;
  cancelComposer(): void;

  /** Editor → comments: the document's block ids in order, `null` while unknown. */
  publishBlocks(ids: string[] | null): void;
  blockOrder: string[] | null;
  /** Editor → comments: scroll/highlight callback for a block id. */
  registerBlockScroller(scroll: ((blockId: string) => void) | null): void;
  scrollToBlock(blockId: string): void;
  /** Editor → comments: the doc has real content (restored locally or synced), so "detached" can be trusted. */
  setContentReady(ready: boolean): void;
}

const CommentsContext = createContext<CommentsContextValue | null>(null);

export function useComments(): CommentsContextValue | null {
  return useContext(CommentsContext);
}

const sameIds = (a: string[] | null, b: string[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((id, i) => id === b[i]));

export function CommentsProvider({
  pageId,
  role,
  children,
}: {
  pageId: string;
  role: EffectiveRole;
  children: ReactNode;
}) {
  const query = useCommentThreads(pageId, canView(role));
  const actions = useCommentActions(pageId);

  const [panelOpen, setPanelOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerTarget | null>(null);
  const [blockOrder, setBlockOrder] = useState<string[] | null>(null);
  const [contentReady, setContentReady] = useState(false);
  const scroller = useRef<((blockId: string) => void) | null>(null);

  const threads = query.data;
  const emptyThreads = useMemo<CommentThread[]>(() => [], []);
  const list = threads ?? emptyThreads;
  const groups = useMemo(
    () => groupThreads(list, contentReady ? blockOrder : null, { showResolved }),
    [list, blockOrder, contentReady, showResolved],
  );

  const publishBlocks = useCallback((ids: string[] | null) => setBlockOrder((prev) => (sameIds(prev, ids) ? prev : ids)), []);
  const registerBlockScroller = useCallback((fn: ((blockId: string) => void) | null) => {
    scroller.current = fn;
  }, []);
  const scrollToBlock = useCallback((blockId: string) => scroller.current?.(blockId), []);

  const selectThread = useCallback(
    (threadId: string | null) => {
      setActiveThreadId(threadId);
      if (!threadId) return;
      setPanelOpen(true);
      setComposer(null);
      const thread = list.find((t) => t.id === threadId);
      if (thread && thread.blockId !== GITHUB_THREAD_BLOCK_ID) scroller.current?.(thread.blockId);
    },
    [list],
  );

  const startThread = useCallback((target: ComposerTarget) => {
    setComposer(target);
    setActiveThreadId(null);
    setPanelOpen(true);
  }, []);
  const cancelComposer = useCallback(() => setComposer(null), []);

  const available = canView(role) && !hasStatus(query.error, 501, 404, 403);

  const value = useMemo<CommentsContextValue>(
    () => ({
      pageId,
      available,
      canComment: canComment(role) && available,
      threads: list,
      groups,
      isLoading: query.isPending && query.fetchStatus !== "idle",
      isError: query.isError && !hasStatus(query.error, 501),
      actions,
      panelOpen,
      setPanelOpen,
      showResolved,
      setShowResolved,
      activeThreadId,
      selectThread,
      composer,
      startThread,
      cancelComposer,
      publishBlocks,
      blockOrder,
      registerBlockScroller,
      scrollToBlock,
      setContentReady,
    }),
    [
      pageId,
      available,
      role,
      list,
      groups,
      query.isPending,
      query.fetchStatus,
      query.isError,
      query.error,
      actions,
      panelOpen,
      showResolved,
      activeThreadId,
      selectThread,
      composer,
      startThread,
      cancelComposer,
      publishBlocks,
      blockOrder,
      registerBlockScroller,
      scrollToBlock,
    ],
  );

  return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>;
}
