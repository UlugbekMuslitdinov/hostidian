import type { Comment, CommentThread, UserRef } from "@hostidian/api-types";

/** Pure cache transforms for optimistic comment updates (the thread list is a plain array in the query cache). */

export const TMP_PREFIX = "tmp-";
export const isTemporaryId = (id: string) => id.startsWith(TMP_PREFIX);

export function newThread(params: {
  tempId: string;
  pageId: string;
  blockId: string;
  quote: string;
  body: string;
  author: UserRef;
  now: string;
}): CommentThread {
  return {
    id: `${TMP_PREFIX}${params.tempId}`,
    pageId: params.pageId,
    blockId: params.blockId,
    quote: params.quote,
    createdBy: params.author,
    resolvedAt: null,
    createdAt: params.now,
    comments: [
      {
        id: `${TMP_PREFIX}c-${params.tempId}`,
        threadId: `${TMP_PREFIX}${params.tempId}`,
        author: params.author,
        body: params.body,
        createdAt: params.now,
        updatedAt: params.now,
      },
    ],
  };
}

export function addThread(list: readonly CommentThread[], thread: CommentThread): CommentThread[] {
  return [...list.filter((t) => t.id !== thread.id), thread];
}

export function addReply(list: readonly CommentThread[], threadId: string, comment: Comment): CommentThread[] {
  return list.map((t) => (t.id === threadId ? { ...t, comments: [...t.comments, comment] } : t));
}

export function editComment(
  list: readonly CommentThread[],
  commentId: string,
  body: string,
  now: string,
): CommentThread[] {
  return list.map((t) =>
    t.comments.some((c) => c.id === commentId)
      ? { ...t, comments: t.comments.map((c) => (c.id === commentId ? { ...c, body, updatedAt: now } : c)) }
      : t,
  );
}

/** Deleting the last comment of a thread deletes the thread (conventions §10). */
export function removeComment(list: readonly CommentThread[], commentId: string): CommentThread[] {
  const out: CommentThread[] = [];
  for (const thread of list) {
    if (!thread.comments.some((c) => c.id === commentId)) {
      out.push(thread);
      continue;
    }
    const comments = thread.comments.filter((c) => c.id !== commentId);
    if (comments.length > 0) out.push({ ...thread, comments });
  }
  return out;
}

export function setResolved(
  list: readonly CommentThread[],
  threadId: string,
  resolved: boolean,
  by: UserRef,
  now: string,
): CommentThread[] {
  return list.map((t) => {
    if (t.id !== threadId) return t;
    if (resolved) return { ...t, resolvedAt: now, resolvedBy: by };
    const rest = { ...t, resolvedAt: null };
    delete rest.resolvedBy;
    return rest;
  });
}
