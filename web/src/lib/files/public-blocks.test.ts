import { describe, expect, it } from "vitest";
import { publicFileUrl, rewriteFileUrl, rewritePublicBlocks } from "./public-blocks";

const TOKEN = "tok_en-123";
const FILE = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000";
const INSIDE = "11111111-1111-4111-8111-111111111111";
const OUTSIDE = "22222222-2222-4222-8222-222222222222";

const opts = { token: TOKEN, allowedPageIds: new Set([INSIDE]) };

describe("rewriteFileUrl", () => {
  it("maps internal file URLs to the public endpoint", () => {
    expect(rewriteFileUrl(`/api/files/${FILE}`, TOKEN)).toBe(`/api/public/${TOKEN}/files/${FILE}`);
    expect(publicFileUrl("a/b", FILE)).toBe(`/api/public/a%2Fb/files/${FILE}`);
  });

  it("keeps a trailing query or fragment", () => {
    expect(rewriteFileUrl(`/api/files/${FILE}?download=1`, TOKEN)).toBe(`/api/public/${TOKEN}/files/${FILE}?download=1`);
    expect(rewriteFileUrl(`/api/files/${FILE}#x`, TOKEN)).toBe(`/api/public/${TOKEN}/files/${FILE}#x`);
  });

  it("leaves everything else alone", () => {
    for (const url of [
      "https://example.com/api/files/" + FILE,
      "//evil.example/api/files/" + FILE,
      `/api/public/${TOKEN}/files/${FILE}`,
      "/api/filesystem/abc",
      "/api/files/",
      "mailto:a@b.c",
      "",
    ]) {
      expect(rewriteFileUrl(url, TOKEN)).toBe(url);
    }
  });
});

describe("rewritePublicBlocks", () => {
  it("rewrites block url props, including nested children, without mutating the input", () => {
    const input = [
      {
        id: "1",
        type: "image",
        props: { url: `/api/files/${FILE}`, caption: "cap" },
        children: [{ id: "2", type: "file", props: { url: `/api/files/${FILE}`, name: "a.pdf" }, children: [] }],
      },
      { id: "3", type: "image", props: { url: "https://cdn.example/x.png" }, children: [] },
    ];
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    const out = rewritePublicBlocks(input, opts) as unknown as Array<Record<string, unknown>>;

    expect((out[0]!.props as { url: string }).url).toBe(`/api/public/${TOKEN}/files/${FILE}`);
    const nested = (out[0]!.children as Array<{ props: { url: string } }>)[0]!;
    expect(nested.props.url).toBe(`/api/public/${TOKEN}/files/${FILE}`);
    expect((out[1]!.props as { url: string }).url).toBe("https://cdn.example/x.png");
    expect(input).toEqual(snapshot);
  });

  it("rewrites file links inside inline content", () => {
    const out = rewritePublicBlocks(
      [
        {
          id: "1",
          type: "paragraph",
          content: [
            { type: "text", text: "see ", styles: {} },
            { type: "link", href: `/api/files/${FILE}`, content: [{ type: "text", text: "the file", styles: {} }] },
          ],
          children: [],
        },
      ],
      opts,
    ) as unknown as Array<{ content: Array<{ href?: string }> }>;
    expect(out[0]!.content[1]!.href).toBe(`/api/public/${TOKEN}/files/${FILE}`);
  });

  it("keeps page links inside the share and flattens the others to plain text", () => {
    const out = rewritePublicBlocks(
      [
        {
          id: "1",
          type: "paragraph",
          content: [
            { type: "pageLink", props: { pageId: INSIDE.toUpperCase(), title: "Inside" } },
            { type: "text", text: " and ", styles: {} },
            { type: "pageLink", props: { pageId: OUTSIDE, title: "Secret plans" } },
            { type: "pageLink", props: { pageId: OUTSIDE, title: "" } },
          ],
          children: [],
        },
      ],
      opts,
    ) as unknown as Array<{ content: Array<Record<string, unknown>> }>;
    const content = out[0]!.content;
    expect(content[0]).toMatchObject({ type: "pageLink" });
    expect(content[2]).toEqual({ type: "text", text: "Secret plans", styles: {} });
    expect(content[3]).toEqual({ type: "text", text: "Untitled", styles: {} });
  });

  it("handles page links and file links in table cells", () => {
    const out = rewritePublicBlocks(
      [
        {
          id: "t",
          type: "table",
          content: {
            type: "tableContent",
            rows: [
              {
                cells: [
                  [{ type: "pageLink", props: { pageId: OUTSIDE, title: "Out" } }],
                  {
                    type: "tableCell",
                    props: {},
                    content: [{ type: "link", href: `/api/files/${FILE}`, content: [] }],
                  },
                ],
              },
            ],
          },
          children: [],
        },
      ],
      opts,
    ) as unknown as Array<{ content: { rows: Array<{ cells: unknown[] }> } }>;
    const [plain, cell] = out[0]!.content.rows[0]!.cells as [Array<{ text: string }>, { content: Array<{ href: string }> }];
    expect(plain[0]!.text).toBe("Out");
    expect(cell.content[0]!.href).toBe(`/api/public/${TOKEN}/files/${FILE}`);
  });

  it("drops junk entries and tolerates missing fields", () => {
    const out = rewritePublicBlocks([null, 7, "x", { id: "1", type: "paragraph" }, { id: "2", type: "paragraph", content: ["raw", null] }], opts);
    expect(out).toHaveLength(2);
    expect((out[1] as unknown as { content: unknown[] }).content).toEqual(["raw"]);
  });
});
