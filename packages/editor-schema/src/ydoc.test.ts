import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  YDOC_FRAGMENT,
  blocksToMarkdown,
  blocksToYDocUpdate,
  markdownToBlocks,
  replaceYDocBlocks,
  yDocToBlocks,
} from "./index";
import { PAGE_A, normalize } from "./test-helpers";

const SOURCE = [
  "# Title",
  "",
  `Link to [[hostidian:${PAGE_A}|Other page]] with **bold**.`,
  "",
  "> [!tip] A callout",
  ">",
  "> with a body",
  "",
  "* a",
  "  * b",
  "",
  "| x | y |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```ts",
  "let a = 1;",
  "```",
].join("\n");

async function docFrom(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await blocksToYDocUpdate(await markdownToBlocks(markdown)));
  return doc;
}

describe("Y.Doc <-> blocks", () => {
  it("uses the shared fragment name", () => {
    expect(YDOC_FRAGMENT).toBe("blocknote");
  });

  it("round-trips blocks through a Y.Doc update, including pageLink and callout nodes", async () => {
    const blocks = await markdownToBlocks(SOURCE);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await blocksToYDocUpdate(blocks));
    expect(doc.getXmlFragment(YDOC_FRAGMENT).length).toBeGreaterThan(0);

    const back = await yDocToBlocks(doc);
    expect(normalize(back)).toEqual(normalize(blocks));
    expect(await blocksToMarkdown(back)).toBe(await blocksToMarkdown(blocks));
    expect(JSON.stringify(back)).toContain('"type":"pageLink"');
    expect(JSON.stringify(back)).toContain('"type":"callout"');
  });

  it("keeps block ids stable across the conversion", async () => {
    const blocks = await markdownToBlocks("one\n\ntwo");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await blocksToYDocUpdate(blocks));
    expect((await yDocToBlocks(doc)).map((b) => b.id)).toEqual(blocks.map((b) => b.id));
  });

  it("reads an empty document as no blocks, and an empty block list as an empty document", async () => {
    expect(await yDocToBlocks(new Y.Doc())).toEqual([]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await blocksToYDocUpdate([]));
    expect(await yDocToBlocks(doc)).toEqual([]);
  });

  it("does not write to the document it reads", async () => {
    const doc = await docFrom(SOURCE);
    const before = Y.encodeStateVector(doc);
    await yDocToBlocks(doc);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it("reads documents with the same state from a peer that applied incremental updates", async () => {
    const a = await docFrom("first");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.on("update", (update: Uint8Array) => Y.applyUpdate(a, update));
    replaceYDocBlocks(b, await markdownToBlocks("first\n\nsecond"));
    expect((await yDocToBlocks(a)).map((x) => x.type)).toEqual(["paragraph", "paragraph"]);
  });
});

describe("replaceYDocBlocks", () => {
  it("replaces the content of a live doc as a diff that peers can merge without duplicating content", async () => {
    const server = await docFrom("# Old title\n\nkept paragraph\n\nremoved paragraph");
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    const serverUpdates: Uint8Array[] = [];
    server.on("update", (update: Uint8Array) => serverUpdates.push(update));

    replaceYDocBlocks(server, await markdownToBlocks("# New title\n\nkept paragraph\n\n[[hostidian:" + PAGE_A + "|P]]"));
    expect(serverUpdates.length).toBeGreaterThan(0);
    for (const update of serverUpdates) Y.applyUpdate(client, update);

    const expected = await blocksToMarkdown(await yDocToBlocks(server));
    expect(expected).toContain("# New title");
    expect(expected).toContain(`[[hostidian:${PAGE_A}|P]]`);
    expect(expected).not.toContain("removed paragraph");
    expect(await blocksToMarkdown(await yDocToBlocks(client))).toBe(expected);
  });

  it("can empty a document", async () => {
    const doc = await docFrom("something");
    replaceYDocBlocks(doc, []);
    expect(await yDocToBlocks(doc)).toEqual([]);
  });
});
