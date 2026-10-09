import { describe, expect, it } from "vitest";
import { presenceFromStates, safeColor } from "./awareness";

const state = (user: unknown) => ({ user }) as Record<string, unknown>;

describe("presenceFromStates", () => {
  it("lists other users, excluding this client and this user's other tabs", () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, state({ id: "me", name: "Me", color: "#ff0000" })],
      [2, state({ id: "me", name: "Me", color: "#ff0000" })],
      [3, state({ id: "u-b", name: "Bea", color: "#00ff00" })],
      [4, state({ id: "u-a", name: "Alan", color: "#0000ff" })],
    ]);
    expect(presenceFromStates(states, 1, "me")).toEqual([
      { id: "u-a", name: "Alan", color: "#0000ff" },
      { id: "u-b", name: "Bea", color: "#00ff00" },
    ]);
  });

  it("collapses multiple clients of the same user", () => {
    const states = new Map<number, Record<string, unknown>>([
      [2, state({ id: "u-a", name: "Alan", color: "#0000ff" })],
      [3, state({ id: "u-a", name: "Alan", color: "#0000ff" })],
    ]);
    expect(presenceFromStates(states, 1, "me")).toHaveLength(1);
  });

  it("ignores malformed states and sanitises colours", () => {
    const states = new Map<number, Record<string, unknown>>([
      [2, {}],
      [3, state(null)],
      [4, state("nope")],
      [5, state({ id: "", name: "x" })],
      [6, state({ id: "u", name: "  " })],
      [7, state({ name: "No id" })],
      [8, state({ id: "u-ok", name: "Okay", color: "url(javascript:alert(1))" })],
    ]);
    expect(presenceFromStates(states, 1, "me")).toEqual([{ id: "u-ok", name: "Okay", color: "#8a8a85" }]);
  });
});

describe("safeColor", () => {
  it("accepts hex colours only", () => {
    expect(safeColor("#abc")).toBe("#abc");
    expect(safeColor("#AABBCC")).toBe("#AABBCC");
    expect(safeColor("red")).toBe("#8a8a85");
    expect(safeColor(undefined)).toBe("#8a8a85");
    expect(safeColor("#12345")).toBe("#8a8a85");
  });
});
