import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks, type HBlock } from "./index";
import { PAGE_A, PAGE_B, normalize } from "./test-helpers";

/** md -> blocks -> md -> blocks; the second blocks must equal the first and the second md the first md. */
async function roundTrip(markdown: string) {
  const blocks1 = await markdownToBlocks(markdown);
  const md1 = await blocksToMarkdown(blocks1);
  const blocks2 = await markdownToBlocks(md1);
  const md2 = await blocksToMarkdown(blocks2);
  return { blocks1, md1, blocks2, md2 };
}

function inlineOf(block: HBlock | undefined): { type: string; [key: string]: unknown }[] {
  return (block?.content ?? []) as { type: string }[];
}

describe("standard Markdown round trip", () => {
  it("keeps headings, styles, links and paragraphs", async () => {
    const { blocks1, md1, blocks2 } = await roundTrip(
      "# Title\n\n## Sub\n\nSome **bold**, *italic*, ~~strike~~ and `code` with a [link](https://example.com/a?b=c).\n",
    );
    expect(md1).toContain("# Title");
    expect(md1).toContain("## Sub");
    expect(md1).toContain("**bold**");
    expect(md1).toContain("*italic*");
    expect(md1).toContain("~~strike~~");
    expect(md1).toContain("`code`");
    expect(md1).toContain("[link](https://example.com/a?b=c)");
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
  });

  it("keeps nested bullet, numbered and check lists", async () => {
    const source = [
      "* a",
      "  * nested b",
      "    * deeper c",
      "* d",
      "",
      "1. one",
      "2. two",
      "   1. two-a",
      "",
      "* [ ] todo",
      "* [x] done",
    ].join("\n");
    const { blocks1, md1, blocks2, md2 } = await roundTrip(source);
    expect(blocks1.map((b) => b.type)).toEqual([
      "bulletListItem",
      "bulletListItem",
      "numberedListItem",
      "numberedListItem",
      "checkListItem",
      "checkListItem",
    ]);
    expect(blocks1[0]?.children[0]?.children[0]?.type).toBe("bulletListItem");
    expect(blocks1[3]?.children[0]?.type).toBe("numberedListItem");
    expect(blocks1[5]?.props).toMatchObject({ checked: true });
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
    expect(md2).toBe(md1);
    expect(md1).toContain("  * nested b");
    expect(md1).toContain("[x] done");
  });

  it("keeps fenced code with its language and Markdown-looking content verbatim", async () => {
    const source = '```ts\nconst a = "[[hostidian:x]]"; // **not bold**\n> [!note] not a callout\n```';
    const { blocks1, md1, blocks2 } = await roundTrip(source);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0]).toMatchObject({ type: "codeBlock", props: { language: "ts" } });
    expect(md1).toBe(source);
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
  });

  it("keeps tables", async () => {
    const source = "| a | b |\n| - | - |\n| 1 | 2 |\n| **x** | [l](https://e.com) |";
    const { blocks1, blocks2, md1, md2 } = await roundTrip(source);
    expect(blocks1).toHaveLength(1);
    expect(blocks1[0]?.type).toBe("table");
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
    expect(md2).toBe(md1);
    expect(md1).toContain("**x**");
  });

  it("does not grow a phantom header row on header-less tables", async () => {
    const headerless = (await markdownToBlocks("| a | b |\n| - | - |\n| 1 | 2 |"))[0];
    if (!headerless || headerless.type !== "table") throw new Error("expected a table");
    // BlockNote's editor creates tables without header rows; GFM export must emit an empty header that import drops.
    const content = { ...headerless.content, headerRows: undefined };
    const md = await blocksToMarkdown([{ ...headerless, content } as HBlock]);
    const back = (await markdownToBlocks(md))[0];
    if (!back || back.type !== "table") throw new Error("expected a table");
    expect(back.content.rows).toHaveLength(2);
    expect(back.content.headerRows).toBeUndefined();
  });

  it("keeps images and file links as /api/files references", async () => {
    const image = "![diagram](/api/files/123e4567-e89b-12d3-a456-426614174000)";
    const file = "[report.pdf](/api/files/123e4567-e89b-12d3-a456-426614174001)";
    const { blocks1, md1 } = await roundTrip(`${image}\n\n${file}`);
    expect(blocks1[0]).toMatchObject({
      type: "image",
      props: { url: "/api/files/123e4567-e89b-12d3-a456-426614174000", name: "diagram" },
    });
    expect(md1).toContain(image);
    expect(md1).toContain(file);
  });

  it("exports captioned images, audio, video and file blocks in the plain dialect", async () => {
    const blocks = [
      { type: "image", props: { url: "/api/files/i1", name: "pic.png", caption: "A caption" } },
      { type: "video", props: { url: "/api/files/v1", name: "clip.mp4" } },
      { type: "audio", props: { url: "/api/files/a1" } },
      { type: "file", props: { url: "/api/files/f1", name: "doc.pdf" } },
    ] as unknown as HBlock[];
    const md = await blocksToMarkdown(blocks);
    expect(md).toBe(
      "![A caption](/api/files/i1)\n\n[clip.mp4](/api/files/v1)\n\n[a1](/api/files/a1)\n\n[doc.pdf](/api/files/f1)",
    );
    expect(md).not.toMatch(/<(figure|audio|video|img)/);
  });

  it("keeps dividers, quotes and hard breaks", async () => {
    const { blocks1, md1, blocks2 } = await roundTrip("> quoted\n\n---\n\nline one\\\nline two");
    expect(blocks1.map((b) => b.type)).toEqual(["quote", "divider", "paragraph"]);
    expect(md1).toContain("> quoted");
    expect(md1).toContain("line one\\\nline two");
    // A hard break must come back as a bare newline: no stray space after it.
    expect(JSON.stringify(blocks1[2]?.content)).toContain("line one\\nline two");
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
  });

  it("handles empty input and CRLF line endings", async () => {
    expect(await blocksToMarkdown([])).toBe("");
    const blocks = await markdownToBlocks("");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("paragraph");
    const crlf = await markdownToBlocks("# A\r\n\r\ntext\r\n");
    expect(crlf.map((b) => b.type)).toEqual(["heading", "paragraph"]);
  });
});

describe("page links", () => {
  it("parses [[hostidian:id|title]] into pageLink nodes and writes them back", async () => {
    const source = `See [[hostidian:${PAGE_A}|Foo bar]] and [[hostidian:${PAGE_B}|Baz]].`;
    const blocks = await markdownToBlocks(source);
    expect(inlineOf(blocks[0])).toEqual([
      { type: "text", text: "See ", styles: {} },
      { type: "pageLink", props: { pageId: PAGE_A, title: "Foo bar" } },
      { type: "text", text: " and ", styles: {} },
      { type: "pageLink", props: { pageId: PAGE_B, title: "Baz" } },
      { type: "text", text: ".", styles: {} },
    ]);
    expect(await blocksToMarkdown(blocks)).toBe(source);
  });

  it("round-trips titles containing brackets, pipes, backslashes, quotes, emoji and [[", async () => {
    const titles = ["Plain", "A | B", "closing ] bracket", "back\\slash", "[[nested]]", 'say "hi"', "日本語 \u{1F680}", " padded "];
    for (const title of titles) {
      const blocks: HBlock[] = [
        {
          id: "x",
          type: "paragraph",
          props: { textColor: "default", backgroundColor: "default", textAlignment: "left" },
          content: [{ type: "pageLink", props: { pageId: PAGE_A, title } }],
          children: [],
        } as unknown as HBlock,
      ];
      const md = await blocksToMarkdown(blocks);
      const back = await markdownToBlocks(md);
      expect(inlineOf(back[0]), `title ${JSON.stringify(title)} via ${md}`).toEqual([
        { type: "pageLink", props: { pageId: PAGE_A, title } },
      ]);
    }
  });

  it("flattens line breaks in titles instead of breaking the syntax", async () => {
    const md = await blocksToMarkdown([
      { type: "paragraph", content: [{ type: "pageLink", props: { pageId: PAGE_A, title: "two\nlines" } }] },
    ] as unknown as HBlock[]);
    expect(md).toBe(`[[hostidian:${PAGE_A}|two lines]]`);
  });

  it("keeps page links inside bold text, lists, headings and table cells", async () => {
    const source = [
      `# Heading [[hostidian:${PAGE_A}|H]]`,
      "",
      `**bold** [[hostidian:${PAGE_A}|B]]`,
      "",
      `* item [[hostidian:${PAGE_B}|I]]`,
      "",
      "| a | b |",
      "| - | - |",
      `| [[hostidian:${PAGE_A}\\|Pipe \\| title]] | x |`,
    ].join("\n");
    const { blocks1, md1, blocks2 } = await roundTrip(source);
    expect(inlineOf(blocks1[0]).some((i) => i.type === "pageLink")).toBe(true);
    const table = blocks1[3];
    if (table?.type !== "table") throw new Error("expected table");
    const cell = table.content.rows[1]?.cells[0];
    expect(JSON.stringify(cell)).toContain('"title":"Pipe | title"');
    // In table rows the id/title pipe and title pipes are escaped so the row keeps its two cells.
    expect(md1).toContain(`[[hostidian:${PAGE_A}\\|Pipe \\| title]]`);
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
  });

  it("leaves unknown [[...]] forms, malformed ids and code untouched", async () => {
    const source = [
      "Obsidian [[Some Title]] and [[Title|alias]] and [[hostidian:not-a-uuid|x]].",
      "",
      `Inline \`[[hostidian:${PAGE_A}|in code]]\` is code.`,
      "",
      "```",
      `[[hostidian:${PAGE_A}|fenced]]`,
      "```",
    ].join("\n");
    const blocks = await markdownToBlocks(source);
    const text = JSON.stringify(blocks);
    expect(text).not.toContain('"pageLink"');
    expect(text).toContain("[[Some Title]]");
    expect(text).toContain("[[hostidian:not-a-uuid|x]]");
    expect(text).toContain(`[[hostidian:${PAGE_A}|in code]]`);
    expect(text).toContain(`[[hostidian:${PAGE_A}|fenced]]`);
  });

  it("normalises upper-case ids and degrades links without a valid id to their title", async () => {
    const blocks = await markdownToBlocks(`[[hostidian:${PAGE_A.toUpperCase()}|Up]]`);
    expect(inlineOf(blocks[0])).toEqual([{ type: "pageLink", props: { pageId: PAGE_A, title: "Up" } }]);

    const md = await blocksToMarkdown([
      { type: "paragraph", content: [{ type: "pageLink", props: { pageId: "", title: "Orphan" } }] },
    ] as unknown as HBlock[]);
    expect(md).toBe("Orphan");
  });

  it("is not confused by user text that resembles internal placeholders", async () => {
    const blocks = await markdownToBlocks("PLK0123456789abn0END and CLO0123456789abn0END");
    const md = await blocksToMarkdown(blocks);
    expect(md).toBe("PLK0123456789abn0END and CLO0123456789abn0END");
  });
});

describe("callouts", () => {
  it("parses all four kinds and writes them back", async () => {
    const source = ["note", "tip", "warning", "danger"].map((k) => `> [!${k}] ${k} text`).join("\n\n");
    const blocks = await markdownToBlocks(source);
    expect(blocks.map((b) => [b.type, (b.props as { kind?: string }).kind])).toEqual([
      ["callout", "note"],
      ["callout", "tip"],
      ["callout", "warning"],
      ["callout", "danger"],
    ]);
    expect(inlineOf(blocks[2])).toEqual([{ type: "text", text: "warning text", styles: {} }]);
    expect(await blocksToMarkdown(blocks)).toBe(source);
  });

  it("round-trips multi-paragraph callouts with lists, code and page links", async () => {
    const source = [
      `> [!tip] Headline with [[hostidian:${PAGE_A}|a link]]`,
      ">",
      "> Second paragraph",
      ">",
      "> * item one",
      "> * item two",
      ">",
      "> ```js",
      "> const a = 1;",
      "> ```",
    ].join("\n");
    const { blocks1, md1, blocks2 } = await roundTrip(source);
    const callout = blocks1[0];
    expect(callout?.type).toBe("callout");
    expect(inlineOf(callout).map((i) => i.type)).toEqual(["text", "pageLink"]);
    expect(callout?.children.map((c) => c.type)).toEqual(["paragraph", "bulletListItem", "bulletListItem", "codeBlock"]);
    expect(md1).toBe(source);
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
  });

  it("supports callouts without text of their own and nested callouts", async () => {
    const source = ["> [!warning]", ">", "> body", ">", "> > [!danger] inner", "> > inner body"].join("\n");
    const { blocks1, blocks2 } = await roundTrip(source);
    const outer = blocks1[0];
    expect(outer).toMatchObject({ type: "callout", props: { kind: "warning" }, content: [] });
    expect(outer?.children.map((c) => c.type)).toEqual(["paragraph", "callout"]);
    expect(outer?.children[1]?.props).toMatchObject({ kind: "danger" });
    expect(normalize(blocks2)).toEqual(normalize(blocks1));
  });

  it("maps Obsidian callout types and ignores fold markers", async () => {
    const blocks = await markdownToBlocks(
      ["> [!INFO]- Folded", "", "> [!success]+ Open", "", "> [!bug] Bug", "", "> [!question] Q", "", "> [!custom-thing] X"].join(
        "\n",
      ),
    );
    expect(blocks.map((b) => (b.props as { kind?: string }).kind)).toEqual(["note", "tip", "danger", "warning", "note"]);
    expect(inlineOf(blocks[0])).toEqual([{ type: "text", text: "Folded", styles: {} }]);
  });

  it("does not treat plain blockquotes or fenced examples as callouts", async () => {
    const blocks = await markdownToBlocks("> just a quote\n\n```md\n> [!note] example\n```");
    expect(blocks.map((b) => b.type)).toEqual(["quote", "codeBlock"]);
  });

  it("splits a callout from surrounding paragraphs", async () => {
    const blocks = await markdownToBlocks("before\n> [!note] x\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "callout", "paragraph"]);
  });

  it("exports callouts that sit between other blocks, keeping hard breaks inside the quote", async () => {
    const blocks = [
      { type: "paragraph", content: "before" },
      { type: "callout", props: { kind: "note" }, content: [{ type: "text", text: "a\nb", styles: {} }], children: [] },
      { type: "paragraph", content: "after" },
    ] as unknown as HBlock[];
    expect(await blocksToMarkdown(blocks)).toBe("before\n\n> [!note] a\\\n> b\n\nafter");
  });

  it("falls back to kind note for an unknown kind value", async () => {
    const md = await blocksToMarkdown([
      { type: "callout", props: { kind: "weird" }, content: [{ type: "text", text: "x", styles: {} }], children: [] },
    ] as unknown as HBlock[]);
    expect(md).toBe("> [!note] x");
  });

  it("bounds nesting depth on hostile input", async () => {
    const hostile = Array.from({ length: 40 }, (_, i) => `${"> ".repeat(i)}[!note] level ${i}`).join("\n");
    const blocks = await markdownToBlocks(hostile);
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe("concurrency", () => {
  it("serialises DOM-backed conversions so parallel calls do not corrupt each other", async () => {
    const jobs = Array.from({ length: 25 }, async (_, i) => {
      const md = `# Doc ${i}\n\n> [!note] callout ${i}\n\n[[hostidian:${PAGE_A}|link ${i}]]`;
      const blocks = await markdownToBlocks(md);
      return blocksToMarkdown(blocks);
    });
    const results = await Promise.all(jobs);
    results.forEach((out, i) => {
      expect(out).toContain(`# Doc ${i}`);
      expect(out).toContain(`> [!note] callout ${i}`);
      expect(out).toContain(`|link ${i}]]`);
    });
  });
});
