import type { PageSummary } from "@hostidian/api-types";
import { pageTitle } from "@/lib/utils";

/**
 * Ranking behind the `[[` page picker. Runs on the cached page tree, so it works offline and needs no
 * round trip per keystroke. Pure.
 */

export const PAGE_LINK_MAX_RESULTS = 8;

const strip = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** 0 = no match; higher is better. */
export function scoreTitle(title: string, query: string): number {
  const t = strip(pageTitle(title));
  const q = strip(query).trim().replace(/\s+/g, " ");
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[\s\-_/.,:;()[\]]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 65;
  if (t.includes(q)) return 50;
  // Every query word must appear (prefix of a word beats a plain substring).
  const tokens = q.split(" ");
  if (tokens.length > 1) {
    let total = 0;
    for (const token of tokens) {
      if (words.some((w) => w.startsWith(token))) total += 30;
      else if (t.includes(token)) total += 20;
      else return isSubsequence(q.replace(/ /g, ""), t) ? 10 : 0;
    }
    return 30 + total / tokens.length / 2;
  }
  return q.length >= 2 && isSubsequence(q, t) ? 10 : 0;
}

export interface RankOptions {
  excludeId?: string;
  limit?: number;
}

/** Best matches first; with an empty query, the most recently edited pages. */
export function rankPages(pages: readonly PageSummary[], query: string, options: RankOptions = {}): PageSummary[] {
  const limit = options.limit ?? PAGE_LINK_MAX_RESULTS;
  const scored: Array<{ page: PageSummary; score: number }> = [];
  for (const page of pages) {
    if (page.archivedAt || page.id === options.excludeId) continue;
    const score = scoreTitle(page.title, query);
    if (score > 0) scored.push({ page, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.page.updatedAt.localeCompare(a.page.updatedAt) ||
      pageTitle(a.page.title).length - pageTitle(b.page.title).length ||
      pageTitle(a.page.title).localeCompare(pageTitle(b.page.title)),
  );
  return scored.slice(0, limit).map((s) => s.page);
}

/** "Projects / Roadmap": the ancestors' titles, to tell same-named pages apart. Empty for roots. */
export function parentPath(pages: readonly PageSummary[], page: PageSummary, maxDepth = 3): string {
  const byId = new Map(pages.map((p) => [p.id, p] as const));
  const titles: string[] = [];
  const seen = new Set<string>([page.id]);
  let parentId = page.parentId;
  while (parentId && titles.length < maxDepth) {
    const parent = byId.get(parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    titles.unshift(pageTitle(parent.title));
    parentId = parent.parentId;
  }
  return titles.join(" / ");
}

/** Offer "Create page “x”" unless a page with exactly that title already exists. */
export function shouldOfferCreate(pages: readonly PageSummary[], query: string): boolean {
  const q = strip(query).trim();
  if (!q) return false;
  return !pages.some((p) => !p.archivedAt && strip(p.title).trim() === q);
}

/** Titles are single-line plain text and the API caps them at 500 characters. */
export function cleanNewPageTitle(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 500);
}
