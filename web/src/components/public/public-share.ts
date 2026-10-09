import type { PublicPage } from "@hostidian/api-types";
import { coverBackground } from "@/lib/covers";
import { rewriteFileUrl } from "@/lib/files/public-blocks";

/** A node of the shared subtree (`PublicPage["tree"][number]`); the generated types don't re-export it. */
export type PublicPageMeta = PublicPage["tree"][number];

/**
 * Pure helpers for the read-only public share page (`/s/<token>`). Kept free of React/network so the
 * URL, allowed-page, cover and tree logic is unit-testable (see public-share.test.ts).
 */

/** Public URL of the shared root, or of one descendant when `pageId` is given. */
export function publicPagePath(token: string, pageId?: string | null): string {
  const base = `/s/${encodeURIComponent(token)}`;
  return pageId ? `${base}/${encodeURIComponent(pageId)}` : base;
}

/** Pages reachable inside this share: the root plus every page in `tree`. Lower-cased for matching. */
export function allowedPageIds(rootPageId: string, tree: readonly PublicPageMeta[]): Set<string> {
  const ids = new Set<string>([rootPageId.toLowerCase()]);
  for (const node of tree) {
    if (node && typeof node.id === "string") ids.add(node.id.toLowerCase());
  }
  return ids;
}

/** Lookup for `pageLink` chips so they can show the current title/icon of a reachable page. */
export function publicPageTitles(
  tree: readonly PublicPageMeta[],
): Map<string, { title: string; icon?: string | null }> {
  const map = new Map<string, { title: string; icon?: string | null }>();
  for (const node of tree) {
    if (node && typeof node.id === "string") {
      map.set(node.id.toLowerCase(), { title: node.title, icon: node.icon ?? null });
    }
  }
  return map;
}

const EXTERNAL_URL_RE = /^https?:\/\//i;
// A same-origin path, but not a protocol-relative `//host` URL.
const SAFE_RELATIVE_RE = /^\/(?!\/)/;

function cssImage(url: string): string {
  return `url(${JSON.stringify(url)}) center / cover no-repeat`;
}

/**
 * CSS `background` for a page cover. Covers are usually preset ids (`coverBackground`), but a page may
 * store an uploaded image `/api/files/<id>` — rewrite it to the public file endpoint (conventions §7).
 * http(s) and same-origin paths are treated as images; anything else degrades to "no cover".
 */
export function publicCoverBackground(cover: string | null | undefined, token: string): string | null {
  if (!cover) return null;
  if (cover.startsWith("/api/files/")) return cssImage(rewriteFileUrl(cover, token));
  if (EXTERNAL_URL_RE.test(cover) || SAFE_RELATIVE_RE.test(cover)) return cssImage(cover);
  return coverBackground(cover);
}

export interface PublicTreeItem {
  id: string;
  title: string;
  icon: string | null;
  depth: number;
  current: boolean;
}

/**
 * Flatten the shared subtree into an ordered list with a nesting `depth` for indentation. Works for
 * any ordering (depth is derived by walking `parentId`s, not from the array position) and tolerates a
 * root whose parent is missing from `tree`.
 */
export function flattenPublicTree(
  tree: readonly PublicPageMeta[],
  currentPageId?: string | null,
): PublicTreeItem[] {
  const byId = new Map(tree.map((node) => [node.id.toLowerCase(), node]));
  const current = currentPageId?.toLowerCase();

  const depthOf = (node: PublicPageMeta): number => {
    let depth = 0;
    const seen = new Set<string>([node.id.toLowerCase()]);
    let parentId = node.parentId ? node.parentId.toLowerCase() : null;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      seen.add(parentId);
      depth += 1;
      parentId = parent.parentId ? parent.parentId.toLowerCase() : null;
    }
    return depth;
  };

  return tree
    .filter((node) => node && typeof node.id === "string")
    .map((node) => ({
      id: node.id,
      title: node.title || "Untitled",
      icon: node.icon ?? null,
      depth: depthOf(node),
      current: node.id.toLowerCase() === current,
    }));
}
