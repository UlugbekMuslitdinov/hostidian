import { describe, expect, it } from "vitest";
import { groupContiguously } from "./slash-items";

describe("groupContiguously", () => {
  it("merges non-adjacent runs of a group, keeping first-appearance order", () => {
    const items = [
      { id: 1, group: "Basic" },
      { id: 2, group: "Others" },
      { id: 3, group: "Basic" },
      { id: 4, group: "Advanced" },
      { id: 5, group: "Others" },
    ];
    expect(groupContiguously(items).map((i) => i.id)).toEqual([1, 3, 2, 5, 4]);
  });

  it("keeps ungrouped items together and returns a new array", () => {
    const items = [{ id: 1 }, { id: 2, group: "A" }, { id: 3 }];
    const out = groupContiguously(items);
    expect(out.map((i) => i.id)).toEqual([1, 3, 2]);
    expect(out).not.toBe(items);
  });
});
