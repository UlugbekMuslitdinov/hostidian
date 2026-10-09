import { describe, expect, it } from "vitest";
import { readableTextColor } from "./avatar";

/** WCAG contrast of `fg` on `bg` (both #rrggbb). */
function contrastOf(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const c = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c((n >> 16) & 255) + 0.7152 * c((n >> 8) & 255) + 0.0722 * c(n & 255);
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

describe("readableTextColor", () => {
  it.each(["#8b5cf6", "#64b5f6", "#81c784", "#e57373", "#ffd54f", "#1f2937", "#ffffff", "#000000", "#f06292"])(
    "gives AA contrast on %s",
    (bg) => {
      expect(contrastOf(readableTextColor(bg), bg)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("prefers white when it is readable and falls back to white for invalid input", () => {
    expect(readableTextColor("#1f2937")).toBe("#ffffff");
    expect(readableTextColor("not-a-colour")).toBe("#ffffff");
  });
});
