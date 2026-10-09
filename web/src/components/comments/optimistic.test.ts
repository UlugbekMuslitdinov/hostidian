import type { Comment } from "@hostidian/api-types";
import { describe, expect, it } from "vitest";
import { addReply, addThread, editComment, newThread, removeComment, setResolved } from "./optimistic";

const me = { id: "u1", name: "Ada", avatarColor: "#fff" };
const NOW = "2026-10-09T12:00:00Z";
const base = newThread({ tempId: "1", pageId: "p", blockId: "b", quote: "q", body: "first", author: me, now: NOW });

describe("optimistic comment transforms", () => {
  it("newThread builds a temporary thread with its first comment", () => {
    expect(base.id).toBe("tmp-1");
    expect(base.comments).toHaveLength(1);
    expect(base.comments[0]!.threadId).toBe("tmp-1");
    expect(base.comments[0]!.body).toBe("first");
    expect(base.resolvedAt).toBeNull();
  });

  it("addThread replaces a thread with the same id", () => {
    const list = addThread([base], { ...base, quote: "changed" });
    expect(list).toHaveLength(1);
    expect(list[0]!.quote).toBe("changed");
  });

  it("addReply appends to the right thread only", () => {
    const other = { ...base, id: "other" };
    const reply: Comment = { id: "r", threadId: base.id, author: me, body: "re", createdAt: NOW, updatedAt: NOW };
    const out = addReply([base, other], base.id, reply);
    expect(out[0]!.comments.map((c) => c.id)).toContain("r");
    expect(out[1]!.comments).toHaveLength(1);
  });

  it("editComment updates body and timestamp without touching the rest", () => {
    const out = editComment([base], base.comments[0]!.id, "edited", "2026-10-10T00:00:00Z");
    expect(out[0]!.comments[0]).toMatchObject({ body: "edited", updatedAt: "2026-10-10T00:00:00Z", createdAt: NOW });
  });

  it("removeComment deletes the thread together with its last comment", () => {
    const reply: Comment = { id: "r", threadId: base.id, author: me, body: "re", createdAt: NOW, updatedAt: NOW };
    const two = addReply([base], base.id, reply);
    const afterFirst = removeComment(two, base.comments[0]!.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.comments.map((c) => c.id)).toEqual(["r"]);
    expect(removeComment(afterFirst, "r")).toEqual([]);
    expect(removeComment(two, "unknown")).toHaveLength(1);
  });

  it("setResolved toggles resolvedAt/resolvedBy", () => {
    const resolved = setResolved([base], base.id, true, me, NOW);
    expect(resolved[0]).toMatchObject({ resolvedAt: NOW, resolvedBy: me });
    const reopened = setResolved(resolved, base.id, false, me, NOW);
    expect(reopened[0]!.resolvedAt).toBeNull();
    expect("resolvedBy" in reopened[0]!).toBe(false);
  });
});
