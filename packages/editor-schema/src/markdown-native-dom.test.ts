// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks } from "./index";
import { PAGE_A } from "./test-helpers";

// With a real DOM present (the browser, or this jsdom environment) the transforms use it directly instead of loading
// @blocknote/server-util, which is what keeps jsdom out of the browser bundle.
describe("Markdown transforms with a native DOM", () => {
  it("round-trips page links and callouts", async () => {
    expect(typeof document).toBe("object");
    const source = [
      `Text [[hostidian:${PAGE_A}|Linked]] and **bold**`,
      "",
      "> [!danger] Watch out",
      ">",
      "> * one",
      "> * two",
    ].join("\n");
    const blocks = await markdownToBlocks(source);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "callout"]);
    expect(await blocksToMarkdown(blocks)).toBe(source);
  });
});
