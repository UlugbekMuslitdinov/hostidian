import { describe, expect, it } from "vitest";
import { makePage } from "@/test/factories";
import {
  ancestorIds,
  buildTree,
  comparePages,
  descendantIds,
  flattenVisible,
  isDescendant,
  moveWithinSiblings,
  resolveDrop,
  resolveDropAtEnd,
} from "./tree";

// Layout used by most tests:
//   workspace:  A(a0) ── A1(a0) ── A1a(a0)
//                    └── A2(a1)
//               B(a1)
//   private:    P(a0) ── P1(a0)
//   shared:     S (parent not visible)
const A = makePage({ id: "A", title: "A", position: "a0" });
const A1 = makePage({ id: "A1", title: "A1", parentId: "A", position: "a0" });
const A1a = makePage({ id: "A1a", title: "A1a", parentId: "A1", position: "a0" });
const A2 = makePage({ id: "A2", title: "A2", parentId: "A", position: "a1" });
const B = makePage({ id: "B", title: "B", position: "a1" });
const P = makePage({ id: "P", title: "P", position: "a0", visibility: "private" });
const P1 = makePage({ id: "P1", title: "P1", parentId: "P", position: "a0" });
const S = makePage({ id: "S", title: "S", parentId: "hidden-parent", position: "a0" });
const ALL = [A2, B, A1a, P1, S, A, P, A1]; // deliberately unsorted

describe("buildTree", () => {
  it("nests children and orders siblings by position", () => {
    const tree = buildTree(ALL);
    expect(tree.roots.workspace.map((n) => n.page.id)).toEqual(["A", "B"]);
    expect(tree.byId.get("A")!.children.map((n) => n.page.id)).toEqual(["A1", "A2"]);
    expect(tree.byId.get("A1")!.children.map((n) => n.page.id)).toEqual(["A1a"]);
  });

  it("splits private roots and pages whose parent is not visible", () => {
    const tree = buildTree(ALL);
    expect(tree.roots.private.map((n) => n.page.id)).toEqual(["P"]);
    expect(tree.roots.shared.map((n) => n.page.id)).toEqual(["S"]);
    expect(tree.sectionById.get("P1")).toBe("private");
    expect(tree.sectionById.get("A1a")).toBe("workspace");
    expect(tree.sectionById.get("S")).toBe("shared");
  });

  it("files other people's private pages (shared with me) under Shared, not Private", () => {
    const theirs = makePage({ id: "T", title: "T", visibility: "private", createdBy: "someone-else", position: "a5" });
    const mine = makePage({ id: "M", title: "M", visibility: "private", createdBy: "me", position: "a6" });
    const tree = buildTree([theirs, mine], { userId: "me" });
    expect(tree.roots.private.map((n) => n.page.id)).toEqual(["M"]);
    expect(tree.roots.shared.map((n) => n.page.id)).toEqual(["T"]);
    expect(tree.sectionById.get("T")).toBe("shared");
    // without a user id everything private is treated as the caller's own
    expect(buildTree([theirs, mine]).roots.private).toHaveLength(2);
  });

  it("breaks position ties by id and compares positions as plain code units (collation C)", () => {
    const x = makePage({ id: "x", position: "a0" });
    const y = makePage({ id: "y", position: "a0" });
    expect(comparePages(x, y)).toBeLessThan(0);
    // "Zz" < "a0" in C collation (uppercase sorts first), unlike localeCompare.
    expect(comparePages({ id: "1", position: "Zz" }, { id: "2", position: "a0" })).toBeLessThan(0);
  });

  it("ignores archived pages", () => {
    const tree = buildTree([A, makePage({ id: "gone", archivedAt: "2026-10-02T00:00:00Z" })]);
    expect(tree.byId.has("gone")).toBe(false);
  });
});

describe("flattenVisible", () => {
  const tree = buildTree(ALL);

  it("only lists children of expanded rows, depth-first", () => {
    const rows = flattenVisible(tree.roots.workspace, new Set(["A"]), "workspace");
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ["A", 0],
      ["A1", 1],
      ["A2", 1],
      ["B", 0],
    ]);
    const deep = flattenVisible(tree.roots.workspace, new Set(["A", "A1"]), "workspace");
    expect(deep.map((r) => r.id)).toEqual(["A", "A1", "A1a", "A2", "B"]);
  });

  it("reports expansion, children and set position for aria attributes", () => {
    const rows = flattenVisible(tree.roots.workspace, new Set(["A"]), "workspace");
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: true, posInSet: 1, setSize: 2 });
    expect(rows[2]).toMatchObject({ id: "A2", hasChildren: false, expanded: false, posInSet: 2, setSize: 2 });
    expect(rows[3]).toMatchObject({ id: "B", posInSet: 2, setSize: 2 });
  });

  it("does not mark leaf pages expanded even if their id is in the set", () => {
    const rows = flattenVisible(tree.roots.workspace, new Set(["B"]), "workspace");
    expect(rows.find((r) => r.id === "B")!.expanded).toBe(false);
  });
});

describe("tree helpers", () => {
  const tree = buildTree(ALL);

  it("finds ancestors and descendants", () => {
    expect(ancestorIds(tree, "A1a")).toEqual(["A", "A1"]);
    expect(ancestorIds(tree, "A")).toEqual([]);
    expect(descendantIds(tree, "A").sort()).toEqual(["A1", "A1a", "A2"]);
  });

  it("isDescendant includes the page itself and follows parents", () => {
    expect(isDescendant(tree, "A1a", "A")).toBe(true);
    expect(isDescendant(tree, "A", "A")).toBe(true);
    expect(isDescendant(tree, "A", "A1a")).toBe(false);
    expect(isDescendant(tree, "B", "A")).toBe(false);
  });
});

describe("resolveDrop", () => {
  const tree = buildTree(ALL);

  it("drop before / after a sibling becomes beforeId / afterId under that sibling's parent", () => {
    expect(resolveDrop(tree, { activeId: "B", overId: "A", position: "before" })).toEqual({
      parentId: null,
      beforeId: "A",
    });
    expect(resolveDrop(tree, { activeId: "A2", overId: "A1", position: "before" })).toEqual({
      parentId: "A",
      beforeId: "A1",
    });
    expect(resolveDrop(tree, { activeId: "A1", overId: "A2", position: "after" })).toEqual({
      parentId: "A",
      afterId: "A2",
    });
  });

  it("drop inside reparents and appends", () => {
    expect(resolveDrop(tree, { activeId: "B", overId: "A2", position: "inside" })).toEqual({ parentId: "A2" });
    expect(resolveDrop(tree, { activeId: "A1a", overId: "B", position: "inside" })).toEqual({ parentId: "B" });
  });

  it("allows moving a nested page to a different place in another subtree", () => {
    expect(resolveDrop(tree, { activeId: "A1a", overId: "A2", position: "after" })).toEqual({
      parentId: "A",
      afterId: "A2",
    });
  });

  it("rejects dropping onto itself or into its own subtree (cycles)", () => {
    expect(resolveDrop(tree, { activeId: "A", overId: "A", position: "inside" })).toBeNull();
    expect(resolveDrop(tree, { activeId: "A", overId: "A1", position: "inside" })).toBeNull();
    expect(resolveDrop(tree, { activeId: "A", overId: "A1a", position: "before" })).toBeNull();
    expect(resolveDrop(tree, { activeId: "A1", overId: "A1a", position: "after" })).toBeNull();
  });

  it("treats no-op drops as null", () => {
    // A1 is already directly before A2, and A2 directly after A1
    expect(resolveDrop(tree, { activeId: "A1", overId: "A2", position: "before" })).toBeNull();
    expect(resolveDrop(tree, { activeId: "A2", overId: "A1", position: "after" })).toBeNull();
    // A2 is already the last child of A: dropping inside A just appends again
    expect(resolveDrop(tree, { activeId: "A2", overId: "A", position: "inside" })).toBeNull();
    // but dropping A1 inside A moves it to the end, which is a change
    expect(resolveDrop(tree, { activeId: "A1", overId: "A", position: "inside" })).toEqual({ parentId: "A" });
  });

  it("refuses top-level moves between Workspace and Private (that is a visibility change)", () => {
    expect(resolveDrop(tree, { activeId: "B", overId: "P", position: "before" })).toBeNull();
    expect(resolveDrop(tree, { activeId: "P", overId: "B", position: "after" })).toBeNull();
    // nesting under a page of the other section is allowed: access then follows the new root
    expect(resolveDrop(tree, { activeId: "B", overId: "P", position: "inside" })).toEqual({ parentId: "P" });
  });

  it("never moves individually shared pages", () => {
    expect(resolveDrop(tree, { activeId: "S", overId: "B", position: "before" })).toBeNull();
    expect(resolveDrop(tree, { activeId: "B", overId: "S", position: "inside" })).toBeNull();
  });

  it("ignores unknown ids", () => {
    expect(resolveDrop(tree, { activeId: "nope", overId: "B", position: "before" })).toBeNull();
  });
});

describe("resolveDropAtEnd", () => {
  const tree = buildTree(ALL);

  it("moves a nested page to the end of its own section's top level", () => {
    expect(resolveDropAtEnd(tree, "A2", "workspace")).toEqual({ parentId: null, afterId: "B" });
    expect(resolveDropAtEnd(tree, "P1", "private")).toEqual({ parentId: null, afterId: "P" });
  });

  it("rejects other sections and pages that are already last", () => {
    expect(resolveDropAtEnd(tree, "A2", "private")).toBeNull();
    expect(resolveDropAtEnd(tree, "B", "workspace")).toBeNull();
    expect(resolveDropAtEnd(tree, "S", "shared")).toBeNull();
  });
});

describe("moveWithinSiblings (Alt+Arrow)", () => {
  const tree = buildTree(ALL);

  it("moves up/down among siblings", () => {
    expect(moveWithinSiblings(tree, "A2", -1)).toEqual({ parentId: "A", beforeId: "A1" });
    expect(moveWithinSiblings(tree, "A1", 1)).toEqual({ parentId: "A", afterId: "A2" });
    expect(moveWithinSiblings(tree, "A", 1)).toEqual({ parentId: null, afterId: "B" });
  });

  it("does nothing at the ends", () => {
    expect(moveWithinSiblings(tree, "A1", -1)).toBeNull();
    expect(moveWithinSiblings(tree, "A2", 1)).toBeNull();
    expect(moveWithinSiblings(tree, "S", 1)).toBeNull();
  });
});
