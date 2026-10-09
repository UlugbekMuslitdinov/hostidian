import { describe, expect, it } from "vitest";
import {
  allowedPageIds,
  flattenPublicTree,
  publicCoverBackground,
  publicPagePath,
  publicPageTitles,
  type PublicPageMeta,
} from "./public-share";

const TOKEN = "tok_en-123";
const FILE = "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000";
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD = "33333333-3333-4333-8333-333333333333";

function meta(id: string, parentId: string | null, title: string, icon: string | null = null): PublicPageMeta {
  return { id, parentId, title, icon };
}

const TREE: PublicPageMeta[] = [
  meta(ROOT, null, "Home", "🏠"),
  meta(CHILD, ROOT, "Guides"),
  meta(GRANDCHILD, CHILD, "Install"),
];

describe("publicPagePath", () => {
  it("builds the root and subpage URL and encodes the token", () => {
    expect(publicPagePath(TOKEN)).toBe(`/s/${TOKEN}`);
    expect(publicPagePath("a/b", CHILD)).toBe(`/s/a%2Fb/${CHILD}`);
  });
});

describe("allowedPageIds", () => {
  it("includes the root and every tree entry, lower-cased", () => {
    const ids = allowedPageIds(ROOT.toUpperCase(), TREE);
    expect([...ids].sort()).toEqual([ROOT, CHILD, GRANDCHILD].sort());
    expect(ids.has(ROOT.toLowerCase())).toBe(true);
  });

  it("ignores junk entries", () => {
    const ids = allowedPageIds(ROOT, [{ id: ROOT, title: "x" }, null as unknown as PublicPageMeta]);
    expect([...ids]).toEqual([ROOT]);
  });
});

describe("publicPageTitles", () => {
  it("maps lower-cased ids to title and icon", () => {
    const titles = publicPageTitles(TREE);
    expect(titles.get(ROOT.toLowerCase())).toEqual({ title: "Home", icon: "🏠" });
    expect(titles.get(CHILD.toLowerCase())).toEqual({ title: "Guides", icon: null });
  });
});

describe("publicCoverBackground", () => {
  it("rewrites an uploaded file cover to the public endpoint", () => {
    expect(publicCoverBackground(`/api/files/${FILE}`, TOKEN)).toBe(
      `url("/api/public/${TOKEN}/files/${FILE}") center / cover no-repeat`,
    );
  });

  it("resolves preset ids to their CSS background", () => {
    expect(publicCoverBackground("sunset", TOKEN)).toBe(
      "linear-gradient(135deg, #f6d365 0%, #fda085 100%)",
    );
  });

  it("passes external and same-origin images through", () => {
    expect(publicCoverBackground("https://cdn.example/x.png", TOKEN)).toBe(
      'url("https://cdn.example/x.png") center / cover no-repeat',
    );
    expect(publicCoverBackground("/brand/cover.jpg", TOKEN)).toBe(
      'url("/brand/cover.jpg") center / cover no-repeat',
    );
  });

  it("returns null for empty or unknown values and never treats //host as relative", () => {
    expect(publicCoverBackground(null, TOKEN)).toBeNull();
    expect(publicCoverBackground("", TOKEN)).toBeNull();
    expect(publicCoverBackground("not-a-preset", TOKEN)).toBeNull();
    expect(publicCoverBackground("//evil.example/x.png", TOKEN)).toBeNull();
  });
});

describe("flattenPublicTree", () => {
  it("derives nesting depth and marks the current page", () => {
    const items = flattenPublicTree(TREE, CHILD.toUpperCase());
    expect(items.map((i) => [i.id, i.depth, i.current])).toEqual([
      [ROOT, 0, false],
      [CHILD, 1, true],
      [GRANDCHILD, 2, false],
    ]);
  });

  it("tolerates a missing parent and falls back to Untitled", () => {
    const items = flattenPublicTree([meta(CHILD, null, "")]);
    expect(items).toHaveLength(1);
    expect(items[0]!.depth).toBe(0);
    expect(items[0]!.title).toBe("Untitled");
  });
});
