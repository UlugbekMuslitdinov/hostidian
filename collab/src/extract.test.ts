import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { blocksToYDocUpdate, markdownToBlocks } from "@hostidian/editor-schema";
import { contentHash, extractContent } from "./extract";
import { OTHER_PAGE_ID, TARGET_PAGE_ID } from "./test-utils";

async function docFromMarkdown(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await blocksToYDocUpdate(await markdownToBlocks(markdown)));
  return doc;
}

const SOURCE = [
  "# Meeting notes",
  "",
  `Follow up on [[hostidian:${TARGET_PAGE_ID}|Project plan]] and [[hostidian:${OTHER_PAGE_ID}|Budget]], again [[hostidian:${TARGET_PAGE_ID}|Project plan]].`,
  "",
  "> [!warning] Deadline",
  ">",
  "> Friday",
  "",
  "* **bold** item",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
].join("\n");

describe("extractContent", () => {
  it("derives markdown, plaintext, blocks and link targets from a Y.Doc", async () => {
    const content = await extractContent(await docFromMarkdown(SOURCE));

    expect(content.markdown).toContain("# Meeting notes");
    expect(content.markdown).toContain(`[[hostidian:${TARGET_PAGE_ID}|Project plan]]`);
    expect(content.markdown).toContain("> [!warning] Deadline");
    expect(content.markdown).toContain("**bold** item");

    expect(content.plaintext).toBe(
      ["Meeting notes", "Follow up on Project plan and Budget, again Project plan.", "Deadline", "Friday", "bold item", "a b", "1 2"].join("\n"),
    );
    expect(content.plaintext).not.toMatch(/[*#>[\]|]/);

    expect(content.linkTargets).toEqual([TARGET_PAGE_ID, OTHER_PAGE_ID]);

    expect(Array.isArray(content.blocks)).toBe(true);
    const types = (content.blocks as Array<{ type: string }>).map((b) => b.type);
    expect(types).toEqual(["heading", "paragraph", "callout", "bulletListItem", "table"]);
    // Blocks go to the API as JSON: they must survive serialisation untouched.
    expect(JSON.parse(JSON.stringify(content.blocks))).toEqual(content.blocks);
  });

  it("returns empty content for an empty document", async () => {
    expect(await extractContent(new Y.Doc())).toEqual({ markdown: "", plaintext: "", blocks: [], linkTargets: [] });
  });

  it("does not modify the document it reads", async () => {
    const doc = await docFromMarkdown(SOURCE);
    const before = Y.encodeStateAsUpdate(doc);
    await extractContent(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("contentHash", () => {
  it("is stable for equal content and changes with any field", async () => {
    const base = await extractContent(await docFromMarkdown("hello"));
    expect(contentHash(base)).toBe(contentHash(structuredClone(base)));
    expect(contentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ ...base, markdown: `${base.markdown}!` })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, plaintext: `${base.plaintext}!` })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, linkTargets: [TARGET_PAGE_ID] })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, blocks: [] })).not.toBe(contentHash(base));
  });

  it("is the same for two loads of the same document state", async () => {
    const update = await blocksToYDocUpdate(await markdownToBlocks("same\n\ncontent"));
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, update);
    Y.applyUpdate(b, update);
    expect(contentHash(await extractContent(a))).toBe(contentHash(await extractContent(b)));
  });
});
