import { describe, expect, it } from "vitest";
import { makePage } from "@/test/factories";
import { computePosition, positionBetween } from "./position";

const a = makePage({ id: "a", position: "a0" });
const b = makePage({ id: "b", position: "a1" });
const c = makePage({ id: "c", position: "a2" });

describe("computePosition", () => {
  it("appends after the last sibling by default", () => {
    const pos = computePosition([c, a, b]);
    expect(pos > "a2").toBe(true);
  });

  it("starts the first child at a0", () => {
    expect(computePosition([])).toBe("a0");
  });

  it("places between neighbours for afterId / beforeId", () => {
    const afterA = computePosition([a, b, c], { afterId: "a" });
    expect(afterA > "a0" && afterA < "a1").toBe(true);
    const beforeC = computePosition([a, b, c], { beforeId: "c" });
    expect(beforeC > "a1" && beforeC < "a2").toBe(true);
    const beforeA = computePosition([a, b, c], { beforeId: "a" });
    expect(beforeA < "a0").toBe(true);
    const afterC = computePosition([a, b, c], { afterId: "c" });
    expect(afterC > "a2").toBe(true);
  });

  it("ignores the page being moved when looking for neighbours", () => {
    // moving "a" after "b": neighbours are b and c, not a
    const pos = computePosition([a, b, c], { afterId: "b", excludeId: "a" });
    expect(pos > "a1" && pos < "a2").toBe(true);
    // moving "b" to the end
    expect(computePosition([a, b, c], { excludeId: "c" }) > "a1").toBe(true);
  });

  it("falls back to appending when the anchor is unknown", () => {
    expect(computePosition([a, b], { afterId: "ghost" }) > "a1").toBe(true);
  });

  it("matches the server ordering: results sort strictly between neighbours in C collation", () => {
    const pos = computePosition([a, b], { afterId: "a" });
    expect([a.position, pos, b.position].slice().sort()).toEqual([a.position, pos, b.position]);
  });
});

describe("positionBetween", () => {
  it("never throws on corrupt or colliding neighbours", () => {
    expect(() => positionBetween("a1", "a0")).not.toThrow();
    expect(() => positionBetween("a1", "a1")).not.toThrow();
    expect(typeof positionBetween("a1", "a1")).toBe("string");
  });
});
