import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { ContentSync, mergeEditors } from "./content-sync";
import type { ExtractedContent } from "./extract";
import { PushError, type ContentPayload, type PushResult } from "./push";
import { OTHER_USER_ID, PAGE_ID, USER_ID, silentLogger } from "./test-utils";

function stateWith(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** Extraction stub: the "markdown" is the text stored in the doc, so each state gives distinguishable content. */
const extract = async (doc: Y.Doc): Promise<ExtractedContent> => ({
  markdown: doc.getText("t").toString(),
  plaintext: doc.getText("t").toString(),
  blocks: [],
  linkTargets: [],
});

interface PushCall {
  pageId: string;
  payload: ContentPayload;
}

function setup(push: (call: PushCall, isStale: () => boolean) => Promise<PushResult> = async () => "ok") {
  const calls: PushCall[] = [];
  const onPageGone = vi.fn();
  const sync = new ContentSync({
    pusher: {
      push: async (pageId, payload, isStale) => {
        const call = { pageId, payload };
        calls.push(call);
        return push(call, isStale);
      },
    },
    logger: silentLogger,
    onPageGone,
    extract,
  });
  return { sync, calls, onPageGone };
}

describe("editor tracking", () => {
  it("lists editors most recent first, once each, and clears after take", () => {
    const { sync } = setup();
    sync.noteEditor(PAGE_ID, USER_ID);
    sync.noteEditor(PAGE_ID, OTHER_USER_ID);
    sync.noteEditor(PAGE_ID, USER_ID);
    expect(sync.takeEditors(PAGE_ID)).toEqual([USER_ID, OTHER_USER_ID]);
    expect(sync.takeEditors(PAGE_ID)).toEqual([]);
  });

  it("restores editors after a failed store without losing newer ones", () => {
    const { sync } = setup();
    sync.noteEditor(PAGE_ID, USER_ID);
    const taken = sync.takeEditors(PAGE_ID);
    sync.noteEditor(PAGE_ID, OTHER_USER_ID);
    sync.restoreEditors(PAGE_ID, taken);
    expect(sync.takeEditors(PAGE_ID)).toEqual([OTHER_USER_ID, USER_ID]);
  });

  it("mergeEditors keeps the newer ids first", () => {
    expect(mergeEditors(["b", "a"], ["a", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("ContentSync.schedule", () => {
  it("extracts and pushes the snapshot with the editors", async () => {
    const { sync, calls } = setup();
    await sync.schedule(PAGE_ID, stateWith("hello"), [USER_ID]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pageId: PAGE_ID, payload: { markdown: "hello", plaintext: "hello", editorIds: [USER_ID] } });
  });

  it("skips the push when the extracted content did not change", async () => {
    const { sync, calls } = setup();
    await sync.schedule(PAGE_ID, stateWith("same"), [USER_ID]);
    await sync.schedule(PAGE_ID, stateWith("same"), [OTHER_USER_ID]);
    expect(calls).toHaveLength(1);
    await sync.schedule(PAGE_ID, stateWith("different"), [OTHER_USER_ID]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.payload.editorIds).toEqual([OTHER_USER_ID]);
  });

  it("does not remember hashes of failed pushes, so the next store retries", async () => {
    let fail = true;
    const { sync, calls } = setup(async () => {
      if (fail) throw new PushError("down", 503);
      return "ok";
    });
    await expect(sync.schedule(PAGE_ID, stateWith("x"), [])).rejects.toBeInstanceOf(PushError);
    fail = false;
    await sync.schedule(PAGE_ID, stateWith("x"), []);
    expect(calls).toHaveLength(2);
  });

  it("forgets the hash for an unloaded page", async () => {
    const { sync, calls } = setup();
    await sync.schedule(PAGE_ID, stateWith("x"), []);
    sync.forget(PAGE_ID);
    await sync.schedule(PAGE_ID, stateWith("x"), []);
    expect(calls).toHaveLength(2);
  });

  it("collapses work that piles up behind a running push into one task with the newest snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { sync, calls } = setup(async (call) => {
      if (call.payload.markdown === "one") await gate;
      return "ok";
    });

    const first = sync.schedule(PAGE_ID, stateWith("one"), [USER_ID]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = sync.schedule(PAGE_ID, stateWith("two"), [OTHER_USER_ID]);
    const third = sync.schedule(PAGE_ID, stateWith("three"), [USER_ID]);
    release();
    await Promise.all([first, second, third]);

    expect(calls.map((c) => c.payload.markdown)).toEqual(["one", "three"]);
    // Editors of the skipped snapshot are carried over to the one that is pushed.
    expect(calls[1]?.payload.editorIds).toEqual([USER_ID, OTHER_USER_ID]);
  });

  it("tells a running push to stop retrying as soon as a newer snapshot is waiting", async () => {
    const staleSeen: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { sync, calls } = setup(async (call, isStale) => {
      if (call.payload.markdown === "old") {
        await gate;
        staleSeen.push(isStale());
        throw new PushError("api down", 503);
      }
      return "ok";
    });
    const old = sync.schedule(PAGE_ID, stateWith("old"), []);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const fresh = sync.schedule(PAGE_ID, stateWith("new"), []);
    release();
    // The superseded push failing is not an error for its waiter: the newer one carries the content.
    await expect(old).resolves.toBeUndefined();
    await expect(fresh).resolves.toBeUndefined();
    expect(staleSeen).toEqual([true]);
    expect(calls.map((c) => c.payload.markdown)).toEqual(["old", "new"]);
  });

  it("moves waiters of a superseded push onto the newer one, so they hear about its outcome", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const strictFlags: Array<boolean | undefined> = [];
    const calls: string[] = [];
    const sync = new ContentSync({
      pusher: {
        push: async (_pageId, payload, _isStale, retry) => {
          calls.push(payload.markdown);
          strictFlags.push(retry ? true : undefined);
          if (payload.markdown === "old") {
            await gate;
            throw new PushError("api down", 503);
          }
          throw new PushError("still down", 503);
        },
      },
      logger: silentLogger,
      onPageGone: () => {},
      extract,
    });
    const strictWaiter = sync.schedule(PAGE_ID, stateWith("old"), [], { strict: true });
    const settled = strictWaiter.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.waitFor(() => expect(calls).toEqual(["old"]));
    const background = sync.schedule(PAGE_ID, stateWith("new"), []);
    background.catch(() => {});
    release();
    // Not "resolved" just because its own push was abandoned: the newer push failed too.
    expect(await settled).toBe("rejected");
    expect(calls).toEqual(["old", "new"]);
    expect(strictFlags).toEqual([true, true]); // the newer push inherited the fail-fast budget
  });

  it("runs different pages independently and in parallel", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { sync } = setup(async (call) => {
      order.push(`start:${call.pageId}`);
      if (call.pageId === PAGE_ID) await gate;
      order.push(`end:${call.pageId}`);
      return "ok";
    });
    const slow = sync.schedule(PAGE_ID, stateWith("a"), []);
    await vi.waitFor(() => expect(order).toContain(`start:${PAGE_ID}`));
    await sync.schedule(OTHER_USER_ID, stateWith("b"), []);
    expect(order).toEqual([`start:${PAGE_ID}`, `start:${OTHER_USER_ID}`, `end:${OTHER_USER_ID}`]);
    release();
    await slow;
  });

  it("drops the document when the API says the page is gone", async () => {
    const { sync, onPageGone } = setup(async () => "not_found");
    await sync.schedule(PAGE_ID, stateWith("x"), []);
    expect(onPageGone).toHaveBeenCalledExactlyOnceWith(PAGE_ID);
  });

  it("survives an extraction failure and keeps working", async () => {
    const calls: string[] = [];
    const sync = new ContentSync({
      pusher: { push: async (pageId) => (calls.push(pageId), "ok") },
      logger: silentLogger,
      onPageGone: () => {},
      extract: async (doc) => {
        if (doc.getText("t").toString() === "bad") throw new Error("cannot convert");
        return extract(doc);
      },
    });
    await expect(sync.schedule(PAGE_ID, stateWith("bad"), [])).rejects.toThrow("cannot convert");
    await sync.schedule(PAGE_ID, stateWith("good"), []);
    expect(calls).toEqual([PAGE_ID]);
  });

  it("drain waits for in-flight work and gives up after the timeout", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { sync } = setup(async () => {
      await gate;
      return "ok";
    });
    const pending = sync.schedule(PAGE_ID, stateWith("x"), []);
    const started = Date.now();
    await sync.drain(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    release();
    await pending;
    await expect(sync.drain(1000)).resolves.toBeUndefined();
  });
});
