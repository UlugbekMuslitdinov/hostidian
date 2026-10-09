import { describe, expect, it } from "vitest";
import { blockText } from "./block-text";

describe("blockText", () => {
  it("joins text, link text and page-link titles", () => {
    expect(
      blockText({
        content: [
          { type: "text", text: "See ", styles: {} },
          { type: "link", href: "https://x", content: [{ type: "text", text: "the docs", styles: {} }] },
          { type: "text", text: " and ", styles: {} },
          { type: "pageLink", props: { pageId: "p", title: "Roadmap" } },
        ],
      }),
    ).toBe("See the docs and Roadmap");
  });

  it("flattens tables row by row", () => {
    expect(
      blockText({
        content: {
          type: "tableContent",
          rows: [
            { cells: [[{ type: "text", text: "a", styles: {} }], { type: "tableCell", content: [{ type: "text", text: "b", styles: {} }] }] },
            { cells: [[{ type: "text", text: "c", styles: {} }], []] },
          ],
        },
      }),
    ).toBe("a | b / c | ");
  });

  it("falls back to a file block's name or caption, and to empty text", () => {
    expect(blockText({ type: "file", props: { name: "report.pdf" } })).toBe("report.pdf");
    expect(blockText({ type: "image", props: { name: "", caption: "A cat" } })).toBe("A cat");
    expect(blockText({ type: "divider" })).toBe("");
    expect(blockText(null)).toBe("");
    expect(blockText({ content: "nope" })).toBe("");
  });
});
