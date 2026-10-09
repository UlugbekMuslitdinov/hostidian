import { createElement, type ReactNode } from "react";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { describe, expect, it } from "vitest";
import { PageLinkContext, schema, type HBlock } from "./index";
import { PAGE_A } from "./test-helpers";

const blocks = [
  {
    id: "c1",
    type: "callout",
    props: { kind: "warning" },
    content: [
      { type: "text", text: "Read ", styles: {} },
      { type: "pageLink", props: { pageId: PAGE_A, title: "Stored title" } },
    ],
    children: [],
  },
] as unknown as HBlock[];

const editor = ServerBlockNoteEditor.create({ schema });

describe("schema", () => {
  it("registers the callout block and the pageLink inline content", () => {
    expect(schema.blockSchema.callout).toMatchObject({ type: "callout", content: "inline" });
    expect(schema.inlineContentSchema.pageLink).toMatchObject({ type: "pageLink", content: "none" });
    expect(Object.keys(schema.blockSchema.callout.propSchema)).toEqual(["kind"]);
    expect(Object.keys(schema.inlineContentSchema.pageLink.propSchema)).toEqual(["pageId", "title"]);
    // default blocks stay available
    expect(schema.blockSchema).toHaveProperty("paragraph");
    expect(schema.blockSchema).toHaveProperty("table");
  });

  it("renders on the server without a provider, falling back to the stored title", async () => {
    // withReactContext keeps the jsdom globals alive until React has finished its deferred work.
    const html = await editor.withReactContext(
      ({ children }: { children?: ReactNode }) => createElement("div", null, children),
      () => editor.blocksToFullHTML(blocks),
    );
    expect(html).toContain('data-content-type="callout"');
    expect(html).toContain('data-kind="warning"');
    expect(html).toContain("hostidian-callout");
    expect(html).toContain("hostidian-page-link");
    expect(html).toContain(`data-page-id="${PAGE_A}"`);
    expect(html).toContain("Stored title");
  });

  it("renders the live title and icon from PageLinkContext when a provider is present", async () => {
    const value = {
      resolve: (id: string) => (id === PAGE_A ? { title: "Renamed page", icon: "\u{1F4D8}" } : undefined),
      onNavigate: () => {},
    };
    const html = await editor.withReactContext(
      ({ children }: { children?: ReactNode }) => createElement(PageLinkContext.Provider, { value }, children),
      () => editor.blocksToFullHTML(blocks),
    );
    expect(html).toContain("Renamed page");
    expect(html).not.toContain("Stored title</span>");
    expect(html).toContain("\u{1F4D8}");
  });
});
