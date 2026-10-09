"use client";

import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { v4 as uuidv4 } from "uuid";
import type { CommentThread, UserRef } from "@hostidian/api-types";
import { api } from "@/lib/api/client";
import { ApiError, errorMessage, hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap, unwrapVoid } from "@/lib/api/unwrap";
import { useSession } from "@/lib/session";
import {
  addReply,
  addThread,
  editComment,
  isTemporaryId,
  newThread,
  removeComment,
  setResolved,
} from "./optimistic";

/** One query holds every thread of the page (resolved ones included); the UI filters. Prefix-invalidated by SSE. */
export const commentThreadsKey = (pageId: string) => [...qk.comments(pageId), "all"] as const;

export const commentThreadsOptions = (pageId: string) =>
  queryOptions({
    queryKey: commentThreadsKey(pageId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/pages/{pageId}/comments", {
          params: { path: { pageId }, query: { includeResolved: true } },
          signal,
        }),
      ),
    retry: (count, error) => (hasStatus(error, 401, 403, 404, 501) ? false : count < 2),
  });

export function useCommentThreads(pageId: string, enabled = true) {
  return useQuery({ ...commentThreadsOptions(pageId), enabled });
}

/** Comments are server-only; fail fast and visibly when offline instead of queueing silently. */
function ensureOnline() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw ApiError.network();
}

interface Optimistic<V> {
  title: string;
  mutate: (vars: V) => Promise<unknown>;
  apply: (list: CommentThread[], vars: V) => CommentThread[];
}

function useOptimisticAction<V>(qc: QueryClient, pageId: string, spec: Optimistic<V>) {
  const key = commentThreadsKey(pageId);
  return useMutation<unknown, Error, V, { previous: CommentThread[] | undefined }>({
    networkMode: "always",
    retry: false,
    mutationFn: async (vars) => {
      ensureOnline();
      return spec.mutate(vars);
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<CommentThread[]>(key);
      if (previous) qc.setQueryData<CommentThread[]>(key, spec.apply(previous, vars));
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
      toast.error(spec.title, { description: errorMessage(error) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.comments(pageId) }),
  });
}

export interface CommentActions {
  createThread(input: { blockId: string; quote: string; body: string }): Promise<boolean>;
  reply(input: { threadId: string; body: string }): Promise<boolean>;
  edit(input: { commentId: string; body: string }): Promise<boolean>;
  remove(input: { commentId: string }): Promise<boolean>;
  setResolved(input: { threadId: string; resolved: boolean }): Promise<boolean>;
}

/** Mutations with optimistic cache updates and rollback; each resolves `true` on success. */
export function useCommentActions(pageId: string): CommentActions {
  const qc = useQueryClient();
  const { user } = useSession();
  const me = useMemo<UserRef>(
    () => ({ id: user.id, name: user.name, avatarColor: user.avatarColor }),
    [user.id, user.name, user.avatarColor],
  );

  const create = useOptimisticAction<{ blockId: string; quote: string; body: string; tempId: string; now: string }>(qc, pageId, {
    title: "Couldn't add your comment",
    mutate: (v) =>
      unwrap(
        api.POST("/pages/{pageId}/comments", {
          params: { path: { pageId } },
          body: { blockId: v.blockId, quote: v.quote, body: v.body },
        }),
      ),
    apply: (list, v) =>
      addThread(list, newThread({ tempId: v.tempId, pageId, blockId: v.blockId, quote: v.quote, body: v.body, author: me, now: v.now })),
  });

  const replyM = useOptimisticAction<{ threadId: string; body: string; tempId: string; now: string }>(qc, pageId, {
    title: "Couldn't post your reply",
    mutate: (v) =>
      unwrap(
        api.POST("/comment-threads/{threadId}/comments", {
          params: { path: { threadId: v.threadId } },
          body: { body: v.body },
        }),
      ),
    apply: (list, v) =>
      addReply(list, v.threadId, {
        id: `tmp-r-${v.tempId}`,
        threadId: v.threadId,
        author: me,
        body: v.body,
        createdAt: v.now,
        updatedAt: v.now,
      }),
  });

  const editM = useOptimisticAction<{ commentId: string; body: string; now: string }>(qc, pageId, {
    title: "Couldn't save your edit",
    mutate: (v) =>
      unwrap(api.PATCH("/comments/{commentId}", { params: { path: { commentId: v.commentId } }, body: { body: v.body } })),
    apply: (list, v) => editComment(list, v.commentId, v.body, v.now),
  });

  const removeM = useOptimisticAction<{ commentId: string }>(qc, pageId, {
    title: "Couldn't delete the comment",
    mutate: (v) => unwrapVoid(api.DELETE("/comments/{commentId}", { params: { path: { commentId: v.commentId } } })),
    apply: (list, v) => removeComment(list, v.commentId),
  });

  const resolveM = useOptimisticAction<{ threadId: string; resolved: boolean; now: string }>(qc, pageId, {
    title: "Couldn't update the thread",
    mutate: (v) =>
      v.resolved
        ? unwrap(api.POST("/comment-threads/{threadId}/resolve", { params: { path: { threadId: v.threadId } } }))
        : unwrap(api.POST("/comment-threads/{threadId}/reopen", { params: { path: { threadId: v.threadId } } })),
    apply: (list, v) => setResolved(list, v.threadId, v.resolved, me, v.now),
  });

  const mutateCreate = create.mutateAsync;
  const mutateReply = replyM.mutateAsync;
  const mutateEdit = editM.mutateAsync;
  const mutateRemove = removeM.mutateAsync;
  const mutateResolve = resolveM.mutateAsync;

  return useMemo(() => {
    const ok = (run: () => Promise<unknown>) =>
      run().then(
        () => true,
        () => false, // already rolled back and toasted by onError
      );
    const now = () => new Date().toISOString();
    return {
      createThread: (input) => ok(() => mutateCreate({ ...input, tempId: uuidv4(), now: now() })),
      reply: (input) => {
        // A thread that hasn't reached the server yet has no real id to reply to.
        if (isTemporaryId(input.threadId)) {
          toast.error("Hold on, this thread is still being created.");
          return Promise.resolve(false);
        }
        return ok(() => mutateReply({ ...input, tempId: uuidv4(), now: now() }));
      },
      edit: (input) => ok(() => mutateEdit({ ...input, now: now() })),
      remove: (input) => ok(() => mutateRemove(input)),
      setResolved: (input) => ok(() => mutateResolve({ ...input, now: now() })),
    } satisfies CommentActions;
  }, [mutateCreate, mutateReply, mutateEdit, mutateRemove, mutateResolve]);
}
