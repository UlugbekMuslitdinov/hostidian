"use client";

import { CheckCircle2, Loader2, MessageSquare, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Comment, CommentThread } from "@hostidian/api-types";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/lib/session";
import { formatRelative, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ThreadView } from "./anchoring";
import { isTemporaryId } from "./optimistic";
import { useComments } from "./comments-context";

function PanelHeader() {
  const comments = useComments();
  if (!comments) return null;
  const total = comments.groups.openCount + comments.groups.resolvedCount;
  return (
    <header className="flex items-center gap-2 border-b px-3 py-2">
      <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-sm font-semibold">Comments</h2>
      {total > 0 ? <span className="text-xs text-muted-foreground">{comments.groups.openCount} open</span> : null}
      <div className="ml-auto flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={comments.showResolved} onCheckedChange={comments.setShowResolved} aria-label="Show resolved" />
          Resolved
        </label>
        <Button variant="ghost" size="icon-sm" aria-label="Close comments" onClick={() => comments.setPanelOpen(false)}>
          <X />
        </Button>
      </div>
    </header>
  );
}

function NewThreadComposer() {
  const comments = useComments();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  if (!comments?.composer) return null;
  const { quote } = comments.composer;

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await comments.actions.createThread({ blockId: comments.composer!.blockId, quote: comments.composer!.quote, body: text });
    setBusy(false);
    if (ok) {
      setBody("");
      comments.cancelComposer();
    }
  };

  return (
    <section className="mb-3 rounded-lg border bg-muted/40 p-3" aria-label="New comment">
      {quote ? <p className="mb-2 border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground italic">{quote}</p> : null}
      <Textarea
        ref={ref}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write a comment…"
        className="min-h-16 bg-background"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={comments.cancelComposer}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim() || busy} onClick={() => void submit()}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Comment
        </Button>
      </div>
    </section>
  );
}

function CommentRow({ comment }: { comment: Comment }) {
  const comments = useComments();
  const { user } = useSession();
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const own = comment.author.id === user.id;
  const pending = isTemporaryId(comment.id);

  if (!comments) return null;

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await comments.actions.edit({ commentId: comment.id, body: text })) setEditing(false);
  };

  return (
    <li className="flex gap-2">
      <UserAvatar name={comment.author.name} color={comment.author.avatarColor} className="mt-0.5 size-6 text-[10px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{comment.author.name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {pending ? "Sending…" : formatRelative(comment.createdAt, now || Date.parse(comment.createdAt))}
          </span>
        </div>
        {editing ? (
          <div className="mt-1">
            <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} className="min-h-16 text-sm" autoFocus />
            <div className="mt-1 flex justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={!draft.trim()} onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">{comment.body}</p>
        )}
        {!editing && own && !pending ? (
          <div className="mt-1 flex gap-1 text-muted-foreground">
            <button
              type="button"
              className="rounded px-1 text-[11px] hover:text-foreground"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="rounded px-1 text-[11px] hover:text-destructive"
              onClick={() => void comments.actions.remove({ commentId: comment.id })}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ReplyBox({ thread }: { thread: CommentThread }) {
  const comments = useComments();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  if (!comments?.canComment) return null;

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await comments.actions.reply({ threadId: thread.id, body: text });
    setBusy(false);
    if (ok) setBody("");
  };

  return (
    <div className="mt-3">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Reply…"
        className="min-h-14 text-sm"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
        }}
      />
      {body.trim() ? (
        <div className="mt-1 flex justify-end">
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Reply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ThreadCard({ view }: { view: ThreadView }) {
  const comments = useComments();
  if (!comments) return null;
  const { thread, resolved, detached, pending } = view;

  return (
    <article
      className={cn(
        "mb-3 rounded-lg border p-3 transition-colors",
        comments.activeThreadId === thread.id && "border-primary/60 ring-1 ring-primary/30",
      )}
      aria-label="Comment thread"
    >
      {detached ? (
        <p className="mb-2 inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
          Detached: the block this was on was deleted
        </p>
      ) : thread.quote ? (
        <button
          type="button"
          className="mb-2 block w-full border-l-2 border-muted-foreground/30 pl-2 text-left text-xs text-muted-foreground italic hover:border-foreground/40"
          onClick={() => !detached && comments.selectThread(thread.id)}
        >
          {thread.quote}
        </button>
      ) : null}

      <ul className="grid gap-3">
        {thread.comments.map((comment) => (
          <CommentRow key={comment.id} comment={comment} />
        ))}
      </ul>

      <ReplyBox thread={thread} />

      <div className="mt-2 flex items-center justify-end gap-1 border-t pt-2">
        {pending ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Sending…
          </span>
        ) : comments.canComment ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void comments.actions.setResolved({ threadId: thread.id, resolved: !resolved })}
          >
            {resolved ? <RotateCcw /> : <CheckCircle2 />}
            {resolved ? "Reopen" : "Resolve"}
          </Button>
        ) : resolved ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <CheckCircle2 className="size-3" /> Resolved
          </span>
        ) : null}
      </div>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 grid justify-items-center gap-2 px-6 text-center text-sm text-muted-foreground">
      <MessageSquare className="size-6 opacity-60" aria-hidden="true" />
      <p className="font-medium text-foreground">No comments yet</p>
      <p>Select text or hover a block and use the comment button to start a thread.</p>
    </div>
  );
}

/** The right-hand thread panel's contents (header + composer + threads). */
export function CommentsPanel({ className }: { className?: string }) {
  const comments = useComments();
  if (!comments) return null;
  const views = comments.groups.visible;

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <PanelHeader />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {comments.composer ? <NewThreadComposer /> : null}
        {comments.isLoading ? (
          <div className="grid gap-2" aria-busy="true" aria-label="Loading comments">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : views.length === 0 && !comments.composer ? (
          <EmptyState />
        ) : (
          views.map((view) => <ThreadCard key={view.thread.id} view={view} />)
        )}
      </div>
    </div>
  );
}
