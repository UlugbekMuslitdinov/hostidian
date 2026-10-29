import type { CommentThread } from "@hostidian/api-types";
import { describe, expect, it } from "vitest";
import { GITHUB_THREAD_BLOCK_ID } from "@/lib/github";
import {
  badgeCount,
  badgeIsResolved,
  collectBlockIds,
  groupThreads,
  layoutBadges,
  quoteFor,
  snippet,
} from "./anchoring";

const author = { id: "u1", name: "Ada", avatarColor: "#fff" };
let n = 0;
function thread(overrides: Omit<Partial<CommentThread>, "comments"> & { blockId: string; comments?: number }): CommentThread {
  n += 1;
  const { comments = 1, ...rest } = overrides;
  const id = rest.id ?? `t${n}`;
  return {
    id,
    pageId: "p",
    quote: "",
    createdAt: `2026-10-0${Math.min(n, 9)}T10:00:00Z`,
    comments: Array.from({ length: comments }, (_, i) => ({
      id: `${id}-c${i}`,
      threadId: id,
      author,
      body: "hi",
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-01T10:00:00Z",
    })),
    ...rest,
  };
}

describe("collectBlockIds", () => {
  it("walks nested children in document order", () => {
    const ids = collectBlockIds([
      { id: "a", children: [{ id: "a1", children: [{ id: "a1x" }] }, { id: "a2" }] },
      { id: "b" },
    ] as Array<{ id: string; children?: unknown[] }>);
    expect(ids).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });

  it("ignores entries without a string id", () => {
    expect(collectBlockIds([{ id: "a" }, { id: 5 as unknown as string }, {} as { id: string }])).toEqual(["a"]);
  });
});

describe("groupThreads", () => {
  const order = ["b1", "b2", "b3"];

  it("orders threads by their block's position in the document, then by creation", () => {
    const t1 = thread({ blockId: "b3" });
    const t2 = thread({ blockId: "b1" });
    const t3 = thread({ blockId: "b1" });
    const g = groupThreads([t1, t2, t3], order, { showResolved: false });
    expect(g.visible.map((v) => v.thread.id)).toEqual([t2.id, t3.id, t1.id]);
    expect([...g.byBlock.keys()]).toEqual(["b1", "b3"]);
    expect(g.byBlock.get("b1")).toHaveLength(2);
  });

  it("flags threads whose block is gone as detached and lists them last", () => {
    const attached = thread({ blockId: "b2" });
    const lost = thread({ blockId: "deleted" });
    const g = groupThreads([lost, attached], order, { showResolved: false });
    expect(g.visible.map((v) => v.thread.id)).toEqual([attached.id, lost.id]);
    expect(g.detached.map((v) => v.thread.id)).toEqual([lost.id]);
    expect(g.byBlock.has("deleted")).toBe(false);
    expect(g.visible[1]!.detached).toBe(true);
  });

  it("flags nothing as detached while the block list is unknown", () => {
    const g = groupThreads([thread({ blockId: "whatever" })], null, { showResolved: false });
    expect(g.detached).toHaveLength(0);
    expect(g.byBlock.get("whatever")).toHaveLength(1);
  });

  it("hides resolved threads unless asked, and counts both kinds", () => {
    const open = thread({ blockId: "b1" });
    const done = thread({ blockId: "b1", resolvedAt: "2026-10-02T00:00:00Z" });
    const hidden = groupThreads([open, done], order, { showResolved: false });
    expect(hidden.visible).toHaveLength(1);
    expect(hidden.openCount).toBe(1);
    expect(hidden.resolvedCount).toBe(1);
    const shown = groupThreads([open, done], order, { showResolved: true });
    expect(shown.visible).toHaveLength(2);
    expect(shown.visible[1]!.resolved).toBe(true);
  });

  it("never flags the GitHub discussion as detached and pins it above every block", () => {
    const first = thread({ blockId: "b1" });
    const github = thread({ blockId: GITHUB_THREAD_BLOCK_ID });
    const lost = thread({ blockId: "deleted" });
    const g = groupThreads([first, lost, github], order, { showResolved: false });
    expect(g.visible.map((v) => v.thread.id)).toEqual([github.id, first.id, lost.id]);
    expect(g.detached.map((v) => v.thread.id)).toEqual([lost.id]);
    // also before the editor has reported its blocks
    const early = groupThreads([first, github], null, { showResolved: false });
    expect(early.visible[0]!.thread.id).toBe(github.id);
  });

  it("marks optimistic threads as pending", () => {
    const g = groupThreads([thread({ id: "tmp-1", blockId: "b1" })], order, { showResolved: false });
    expect(g.visible[0]!.pending).toBe(true);
  });
});

describe("badges", () => {
  it("counts comments in open threads, falling back to all when everything is resolved", () => {
    const open = groupThreads([thread({ blockId: "b", comments: 3 }), thread({ blockId: "b", comments: 2, resolvedAt: "x" })], null, {
      showResolved: true,
    }).byBlock.get("b")!;
    expect(badgeCount(open)).toBe(3);
    expect(badgeIsResolved(open)).toBe(false);

    const done = groupThreads([thread({ blockId: "c", comments: 2, resolvedAt: "x" })], null, { showResolved: true }).byBlock.get("c")!;
    expect(badgeCount(done)).toBe(2);
    expect(badgeIsResolved(done)).toBe(true);
  });

  it("layoutBadges pushes overlapping badges down but keeps spaced ones where they are", () => {
    const out = layoutBadges(
      [
        { blockId: "c", top: 100 },
        { blockId: "a", top: 10 },
        { blockId: "b", top: 14 },
        { blockId: "d", top: 101 },
      ],
      24,
      4,
    );
    expect(out).toEqual([
      { blockId: "a", top: 10 },
      { blockId: "b", top: 38 },
      { blockId: "c", top: 100 },
      { blockId: "d", top: 128 },
    ]);
  });
});

describe("snippet / quoteFor", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(snippet("  a \n b\t c ")).toBe("a b c");
    expect(snippet("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(snippet("short", 10)).toBe("short");
  });

  it("prefers the selection over the block text and caps at 500 characters", () => {
    expect(quoteFor("picked words", "the whole block")).toBe("picked words");
    expect(quoteFor("   ", "the whole block")).toBe("the whole block");
    expect(quoteFor("", "y".repeat(900))).toHaveLength(500);
  });
});
