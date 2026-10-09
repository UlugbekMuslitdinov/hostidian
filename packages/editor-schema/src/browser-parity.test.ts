// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { YDOC_FRAGMENT, blocksToMarkdown, schema, yDocToBlocks } from "./index";
import { PAGE_A } from "./test-helpers";

/**
 * The web app creates its editor with this schema and a Yjs fragment. Documents written by that mounted editor must be
 * readable by the headless converters collab uses (same ProseMirror node names and attributes on both sides).
 */
describe("mounted editor <-> headless converters", () => {
  it("reads what a collaborative editor wrote, including pageLink and callout nodes", async () => {
    const doc = new Y.Doc();
    // BlockNote 0.55 wires collaboration through `withCollaboration`, not a `collaboration` editor option.
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema,
        collaboration: {
          fragment: doc.getXmlFragment(YDOC_FRAGMENT),
          user: { name: "Ada", color: "#6366f1" },
          provider: { awareness: new Awareness(doc) },
        },
      }),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    // y-prosemirror binds the view to the Yjs fragment on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      editor.replaceBlocks(editor.document, [
        { type: "heading", props: { level: 2 }, content: "Typed in the editor" },
        {
          type: "paragraph",
          content: ["See ", { type: "pageLink", props: { pageId: PAGE_A, title: "Other page" } }, " for details."],
        },
        { type: "callout", props: { kind: "danger" }, content: "Careful here" },
        { type: "bulletListItem", content: "item" },
      ]);

      const blocks = await yDocToBlocks(doc);
      expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "callout", "bulletListItem"]);
      expect(await blocksToMarkdown(blocks)).toBe(
        [
          "## Typed in the editor",
          "",
          `See [[hostidian:${PAGE_A}|Other page]] for details.`,
          "",
          "> [!danger] Careful here",
          "",
          "* item",
        ].join("\n"),
      );
    } finally {
      editor.unmount();
      host.remove();
    }
  });
});
