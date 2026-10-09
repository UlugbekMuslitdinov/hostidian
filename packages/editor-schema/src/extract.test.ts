import { describe, expect, it } from "vitest";
import { blocksToPlaintext, extractPageLinkIds, markdownToBlocks, type HBlock } from "./index";
import { PAGE_A, PAGE_B, PAGE_C } from "./test-helpers";

const link = (pageId: string, title = "T") => ({ type: "pageLink", props: { pageId, title } });
const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });

describe("extractPageLinkIds", () => {
  it("returns distinct ids in document order, including nested children, table cells and callouts", async () => {
    const blocks = [
      { type: "paragraph", content: [link(PAGE_B), text(" "), link(PAGE_A), link(PAGE_B)], children: [] },
      {
        type: "bulletListItem",
        content: [text("x")],
        children: [{ type: "paragraph", content: [link(PAGE_C)], children: [] }],
      },
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: [[text("a")], { type: "tableCell", content: [link(PAGE_A.replace("ab", "ad"))], props: {} }] }],
        },
        children: [],
      },
      { type: "callout", props: { kind: "note" }, content: [link("22222222-2222-4222-8222-222222222222")], children: [] },
    ] as unknown as HBlock[];
    expect(extractPageLinkIds(blocks)).toEqual([
      PAGE_B,
      PAGE_A,
      PAGE_C,
      PAGE_A.replace("ab", "ad"),
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("lower-cases ids and drops malformed or empty ones", () => {
    const blocks = [
      {
        type: "paragraph",
        content: [link(PAGE_A.toUpperCase()), link(""), link("nope"), link(PAGE_A), link("abc-def")],
        children: [],
      },
    ] as unknown as HBlock[];
    expect(extractPageLinkIds(blocks)).toEqual([PAGE_A]);
  });

  it("finds links parsed from Markdown", async () => {
    const blocks = await markdownToBlocks(`a [[hostidian:${PAGE_A}|A]] b [[hostidian:${PAGE_B}|B]] c [[hostidian:${PAGE_A}|A again]]`);
    expect(extractPageLinkIds(blocks)).toEqual([PAGE_A, PAGE_B]);
  });

  it("returns nothing for an empty document", () => {
    expect(extractPageLinkIds([])).toEqual([]);
  });
});

describe("blocksToPlaintext", () => {
  it("emits visible text only: no Markdown syntax, link titles instead of ids", async () => {
    const blocks = await markdownToBlocks(
      [
        "# Heading",
        "",
        "Some **bold** and *italic* with `code` and [a link](https://example.com).",
        "",
        `Go to [[hostidian:${PAGE_A}|Target page]].`,
        "",
        "* item one",
        "  * nested item",
        "",
        "> [!warning] Careful",
        ">",
        "> callout body",
        "",
        "| h1 | h2 |",
        "| -- | -- |",
        "| c1 | c2 |",
        "",
        "---",
        "",
        "```js",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    expect(blocksToPlaintext(blocks)).toBe(
      [
        "Heading",
        "Some bold and italic with code and a link.",
        "Go to Target page.",
        "item one",
        "nested item",
        "Careful",
        "callout body",
        "h1 h2",
        "c1 c2",
        "const x = 1;",
      ].join("\n"),
    );
  });

  it("includes captions and file names, skips empty blocks, keeps hard breaks", () => {
    const blocks = [
      { type: "paragraph", content: [], children: [] },
      { type: "image", props: { url: "/api/files/1", name: "IMG_0001.png", caption: "A sunset" }, children: [] },
      { type: "file", props: { url: "/api/files/2", name: "report.pdf", caption: "" }, children: [] },
      { type: "paragraph", content: [text("one\ntwo")], children: [] },
      { type: "divider", children: [] },
    ] as unknown as HBlock[];
    expect(blocksToPlaintext(blocks)).toBe("A sunset\nreport.pdf\none\ntwo");
  });

  it("returns an empty string for an empty document", () => {
    expect(blocksToPlaintext([])).toBe("");
  });
});
