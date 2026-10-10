import { describe, expect, it } from "vitest";
import { reuseBlockIds, type IdentifiedBlock } from "./block-ids";

const block = (type: string, text: string, id?: string, children: IdentifiedBlock[] = []) =>
  ({ ...(id ? { id } : {}), type, props: {}, content: [{ type: "text", text }], children }) as IdentifiedBlock;
const ids = (blocks: IdentifiedBlock[]): Array<string | undefined> => blocks.map((b) => b.id);

describe("reuseBlockIds", () => {
  it("keeps the ids of identical blocks, including nested ones, wherever they moved", () => {
    const existing = [block("heading", "A", "h"), block("paragraph", "x", "p1"), block("bulletListItem", "i", "l", [block("bulletListItem", "j", "l2")])];
    const incoming = [
      block("heading", "A"),
      block("paragraph", "new"),
      block("bulletListItem", "i", undefined, [block("bulletListItem", "j")]),
    ];
    reuseBlockIds(existing, incoming);
    expect(ids(incoming)).toEqual(["h", "p1", "l"]); // the rewritten paragraph counts as an edit of p1
    expect(incoming[2]?.children?.[0]?.id).toBe("l2");
  });

  it("treats an edited block of the same type at the same position as the same block", () => {
    const existing = [block("paragraph", "one", "a"), block("paragraph", "two", "b"), block("paragraph", "three", "c")];
    const incoming = [block("paragraph", "one"), block("paragraph", "TWO edited"), block("paragraph", "three")];
    reuseBlockIds(existing, incoming);
    expect(ids(incoming)).toEqual(["a", "b", "c"]);
  });

  it("does not reuse an id for a different block type, or twice", () => {
    const existing = [block("heading", "A", "h")];
    const incoming = [block("paragraph", "A"), block("heading", "A")];
    reuseBlockIds(existing, incoming);
    expect(ids(incoming)).toEqual([undefined, "h"]);
  });

  it("handles insertions at the front and removals", () => {
    const existing = [block("paragraph", "a", "1"), block("paragraph", "b", "2"), block("paragraph", "c", "3")];
    const incoming = [block("paragraph", "zero"), block("paragraph", "a"), block("paragraph", "c")];
    reuseBlockIds(existing, incoming);
    expect(ids(incoming).slice(1)).toEqual(["1", "3"]);
  });
});
