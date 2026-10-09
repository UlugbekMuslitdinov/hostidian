import { describe, expect, it } from "vitest";
import { makePage } from "@/test/factories";
import { cleanNewPageTitle, parentPath, rankPages, scoreTitle, shouldOfferCreate } from "./page-link-search";

describe("scoreTitle", () => {
  it("orders exact > prefix > word start > substring > fuzzy > none", () => {
    const scores = ["Roadmap", "Roadmap 2026", "Q3 Roadmap", "Preroadmaps", "R-o-a-d-m-a-p"].map((t) =>
      scoreTitle(t, "roadmap"),
    );
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(scores[2]).toBeGreaterThan(scores[3]!);
    expect(scores[3]).toBeGreaterThan(scores[4]!);
    expect(scores[4]).toBeGreaterThan(0);
    expect(scoreTitle("Meeting notes", "roadmap")).toBe(0);
  });

  it("ignores case and diacritics", () => {
    expect(scoreTitle("Café Menü", "cafe")).toBeGreaterThan(50);
    expect(scoreTitle("CAFÉ", "café")).toBe(100);
  });

  it("matches multi-word queries in any order", () => {
    expect(scoreTitle("Team meeting notes", "notes meeting")).toBeGreaterThan(0);
    expect(scoreTitle("Team meeting notes", "notes zebra")).toBe(0);
  });

  it("treats an untitled page as 'Untitled'", () => {
    expect(scoreTitle("", "untit")).toBeGreaterThan(0);
  });

  it("everything matches an empty query", () => {
    expect(scoreTitle("anything", "  ")).toBeGreaterThan(0);
  });
});

describe("rankPages", () => {
  const pages = [
    makePage({ id: "a", title: "Notes", updatedAt: "2026-10-01T00:00:00Z" }),
    makePage({ id: "b", title: "Meeting notes", updatedAt: "2026-10-05T00:00:00Z" }),
    makePage({ id: "c", title: "Shopping", updatedAt: "2026-10-08T00:00:00Z" }),
    makePage({ id: "d", title: "Notes (old)", updatedAt: "2026-09-01T00:00:00Z", archivedAt: "2026-09-02T00:00:00Z" }),
    makePage({ id: "e", title: "Release notes", updatedAt: "2026-10-03T00:00:00Z" }),
  ];

  it("returns the most recently edited pages for an empty query", () => {
    expect(rankPages(pages, "").map((p) => p.id)).toEqual(["c", "b", "e", "a"]);
  });

  it("ranks the best title match first and skips archived pages", () => {
    expect(rankPages(pages, "notes").map((p) => p.id)).toEqual(["a", "b", "e"]);
  });

  it("excludes the current page and honours the limit", () => {
    expect(rankPages(pages, "", { excludeId: "c", limit: 2 }).map((p) => p.id)).toEqual(["b", "e"]);
  });

  it("breaks score ties by recency", () => {
    const tied = [
      makePage({ id: "x", title: "Plan A", updatedAt: "2026-01-01T00:00:00Z" }),
      makePage({ id: "y", title: "Plan B", updatedAt: "2026-02-01T00:00:00Z" }),
    ];
    expect(rankPages(tied, "plan").map((p) => p.id)).toEqual(["y", "x"]);
  });
});

describe("parentPath", () => {
  const root = makePage({ id: "r", title: "Projects", parentId: null });
  const mid = makePage({ id: "m", title: "", parentId: "r" });
  const leaf = makePage({ id: "l", title: "Roadmap", parentId: "m" });

  it("joins ancestor titles, root first", () => {
    expect(parentPath([root, mid, leaf], leaf)).toBe("Projects / Untitled");
    expect(parentPath([root, mid, leaf], root)).toBe("");
  });

  it("survives cycles and missing parents", () => {
    const a = makePage({ id: "a", parentId: "b", title: "A" });
    const b = makePage({ id: "b", parentId: "a", title: "B" });
    expect(parentPath([a, b], a)).toBe("B");
    expect(parentPath([leaf], leaf)).toBe("");
  });

  it("caps the depth", () => {
    const chain = ["1", "2", "3", "4", "5"].map((id, i, all) =>
      makePage({ id, title: `T${id}`, parentId: i === 0 ? null : all[i - 1]! }),
    );
    expect(parentPath(chain, chain[4]!)).toBe("T2 / T3 / T4");
  });
});

describe("create entry", () => {
  const pages = [makePage({ title: "Roadmap" }), makePage({ title: "Old", archivedAt: "2026-01-01T00:00:00Z" })];

  it("is offered only for a non-empty query without an exact title match", () => {
    expect(shouldOfferCreate(pages, "")).toBe(false);
    expect(shouldOfferCreate(pages, "   ")).toBe(false);
    expect(shouldOfferCreate(pages, "road")).toBe(true);
    expect(shouldOfferCreate(pages, "roadmap")).toBe(false);
    expect(shouldOfferCreate(pages, " ROADMAP ")).toBe(false);
    expect(shouldOfferCreate(pages, "Old")).toBe(true); // archived pages don't count
  });

  it("cleans the query into a title", () => {
    expect(cleanNewPageTitle("  Two\n  words ")).toBe("Two words");
    expect(cleanNewPageTitle("x".repeat(600))).toHaveLength(500);
  });
});
