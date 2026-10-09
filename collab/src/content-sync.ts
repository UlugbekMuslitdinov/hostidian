import * as Y from "yjs";
import { contentHash, extractContent, type ExtractedContent } from "./extract";
import { errorFields, type Logger } from "./logger";
import type { RetryOptions } from "./persistence";
import type { ContentPayload, PushResult } from "./push";

export interface ContentSyncOptions {
  pusher: {
    push(
      pageId: string,
      payload: ContentPayload,
      isStale: () => boolean,
      retry?: Partial<RetryOptions>,
    ): Promise<PushResult>;
  };
  logger: Logger;
  /** The API answered 404: the page is gone and its document should be dropped. */
  onPageGone: (pageId: string) => void;
  /** Injectable for tests. */
  extract?: (doc: Y.Doc) => Promise<ExtractedContent>;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Task {
  state: Uint8Array;
  editorIds: string[];
  waiters: Waiter[];
  /** Someone is waiting on the result (markdown import): fail fast instead of retrying for minutes. */
  strict: boolean;
}

/** Retry budget for `strict` tasks: about two seconds, then the caller gets the error. */
const STRICT_RETRY: Partial<RetryOptions> = { attempts: 3, baseDelayMs: 500, maxDelayMs: 1_000 };

interface Slot {
  running: boolean;
  pending?: Task;
}

/** Most recent first, each id once. */
export function mergeEditors(newer: readonly string[], older: readonly string[]): string[] {
  return [...new Set([...newer, ...older])];
}

/**
 * After a document has been persisted, derives its content (blocks -> markdown/plaintext/links) and pushes it to the API.
 *
 * - Never on the editing path: callers hand over a Yjs snapshot and move on.
 * - At most one extraction/push per page runs at a time, and work for a page that piles up while one is running
 *   collapses into a single task holding the newest snapshot (so an older push can never land after a newer one).
 * - A push is skipped when the extracted content hashes the same as the last successful push.
 */
export class ContentSync {
  private readonly slots = new Map<string, Slot>();
  private readonly lastPushed = new Map<string, string>();
  private readonly editors = new Map<string, string[]>();
  private readonly idleWaiters: Array<() => void> = [];
  private readonly extract: (doc: Y.Doc) => Promise<ExtractedContent>;

  constructor(private readonly options: ContentSyncOptions) {
    this.extract = options.extract ?? extractContent;
  }

  /** Records that `userId` changed the page; consumed by the next `takeEditors`. */
  noteEditor(pageId: string, userId: string): void {
    const list = this.editors.get(pageId) ?? [];
    this.editors.set(pageId, mergeEditors([userId], list));
  }

  /** Users that changed the page since the last call, most recent first. */
  takeEditors(pageId: string): string[] {
    const list = this.editors.get(pageId) ?? [];
    this.editors.delete(pageId);
    return list;
  }

  /** Puts editors back after a failed store so they are reported with the next successful one. */
  restoreEditors(pageId: string, editorIds: readonly string[]): void {
    this.editors.set(pageId, mergeEditors(this.editors.get(pageId) ?? [], editorIds));
  }

  /** Forget cached state for an unloaded page. Work already scheduled still completes. */
  forget(pageId: string): void {
    this.lastPushed.delete(pageId);
    this.editors.delete(pageId);
  }

  /**
   * Queues extraction+push of `state` (a complete Yjs update). The promise settles once this state, or a newer one that
   * superseded it, has been pushed (or skipped as unchanged); it rejects if extraction or the push failed for good.
   * Fire-and-forget callers should `.catch(() => {})`: failures are logged here already.
   */
  schedule(
    pageId: string,
    state: Uint8Array,
    editorIds: readonly string[],
    { strict = false }: { strict?: boolean } = {},
  ): Promise<void> {
    let slot = this.slots.get(pageId);
    if (!slot) {
      slot = { running: false };
      this.slots.set(pageId, slot);
    }
    const result = new Promise<void>((resolve, reject) => {
      if (slot.pending) {
        slot.pending.state = state;
        slot.pending.editorIds = mergeEditors(editorIds, slot.pending.editorIds);
        slot.pending.waiters.push({ resolve, reject });
        slot.pending.strict ||= strict;
      } else {
        slot.pending = { state, editorIds: [...editorIds], waiters: [{ resolve, reject }], strict };
      }
    });
    if (!slot.running) void this.run(pageId, slot);
    return result;
  }

  /** Resolves when no page has work in flight, or after `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.slots.size === 0) return;
    await Promise.race([
      new Promise<void>((resolve) => this.idleWaiters.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  private async run(pageId: string, slot: Slot): Promise<void> {
    slot.running = true;
    try {
      while (slot.pending) {
        const task = slot.pending;
        slot.pending = undefined;
        try {
          await this.process(pageId, task, slot);
          for (const waiter of task.waiters) waiter.resolve();
        } catch (error) {
          this.options.logger.error("content extraction/push failed", { pageId, ...errorFields(error) });
          for (const waiter of task.waiters) waiter.reject(error);
        }
      }
    } finally {
      slot.running = false;
      this.slots.delete(pageId);
      if (this.slots.size === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private async process(pageId: string, task: Task, slot: Slot): Promise<void> {
    const doc = new Y.Doc();
    let content: ExtractedContent;
    try {
      Y.applyUpdate(doc, task.state);
      content = await this.extract(doc);
    } finally {
      doc.destroy();
    }

    const hash = contentHash(content);
    if (this.lastPushed.get(pageId) === hash) {
      this.options.logger.debug("content unchanged, push skipped", { pageId });
      return;
    }

    let result: PushResult;
    try {
      result = await this.options.pusher.push(
        pageId,
        { ...content, editorIds: task.editorIds },
        () => slot.pending !== undefined,
        task.strict ? STRICT_RETRY : undefined,
      );
    } catch (error) {
      // Retries stop as soon as a newer snapshot is waiting; that one is about to be pushed instead. Whoever was
      // waiting on this snapshot now waits on the newer one (and its fail-fast setting), so a caller that needs a
      // confirmed push is never told "done" while the content is still undelivered.
      if (slot.pending) {
        this.options.logger.debug("push superseded by newer content", { pageId });
        slot.pending.waiters.push(...task.waiters);
        slot.pending.strict ||= task.strict;
        task.waiters = [];
        return;
      }
      throw error;
    }

    if (result === "not_found") {
      this.options.logger.warn("API reports the page no longer exists; dropping its document", { pageId });
      this.lastPushed.delete(pageId);
      this.options.onPageGone(pageId);
      return;
    }
    this.lastPushed.set(pageId, hash);
    this.options.logger.debug("content pushed", { pageId, links: content.linkTargets.length });
  }
}
