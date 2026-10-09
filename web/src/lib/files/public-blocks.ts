import type { HPartialBlock } from "@hostidian/editor-schema/react";

/**
 * Prepares stored BlockNote JSON (`GET /public/{token}/page`) for the read-only public renderer:
 *  - `/api/files/<id>` URLs (block `url` props, inline links) → `/api/public/<token>/files/<id>` (conventions §7)
 *  - `pageLink` chips pointing outside the shared subtree become plain text (they'd be dead links).
 * Pure and non-mutating; tolerant of unexpected shapes (the blocks are opaque JSON to the API).
 */

type Json = Record<string, unknown>;

const FILE_URL_RE = /^\/api\/files\/([0-9a-fA-F-]{8,64})(?=$|[?#/])/;

export function publicFileUrl(token: string, fileId: string): string {
  return `/api/public/${encodeURIComponent(token)}/files/${fileId}`;
}

/** Rewrite one URL; anything that isn't a relative `/api/files/<id>` URL is returned untouched. */
export function rewriteFileUrl(url: string, token: string): string {
  const match = FILE_URL_RE.exec(url);
  if (!match) return url;
  return `${publicFileUrl(token, match[1]!)}${url.slice(match[0].length)}`;
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export interface PublicRewriteOptions {
  token: string;
  /** Pages reachable inside this share; links to anything else are flattened to text. */
  allowedPageIds: ReadonlySet<string>;
}

function rewriteInline(item: unknown, opts: PublicRewriteOptions): unknown[] {
  if (typeof item === "string") return [item];
  if (!isObject(item)) return [];
  if (item.type === "pageLink") {
    const props = isObject(item.props) ? item.props : {};
    const pageId = typeof props.pageId === "string" ? props.pageId.toLowerCase() : "";
    if (pageId && opts.allowedPageIds.has(pageId)) return [item];
    const title = typeof props.title === "string" && props.title ? props.title : "Untitled";
    return [{ type: "text", text: title, styles: {} }];
  }
  if (item.type === "link") {
    const href = typeof item.href === "string" ? rewriteFileUrl(item.href, opts.token) : item.href;
    const content = Array.isArray(item.content) ? item.content.flatMap((child) => rewriteInline(child, opts)) : item.content;
    return [{ ...item, href, content }];
  }
  return [item];
}

function rewriteInlineList(content: unknown[], opts: PublicRewriteOptions): unknown[] {
  return content.flatMap((item) => rewriteInline(item, opts));
}

function rewriteTable(content: Json, opts: PublicRewriteOptions): Json {
  if (!Array.isArray(content.rows)) return content;
  const rows = content.rows.map((row) => {
    if (!isObject(row) || !Array.isArray(row.cells)) return row;
    const cells = row.cells.map((cell) => {
      if (Array.isArray(cell)) return rewriteInlineList(cell, opts);
      if (isObject(cell) && Array.isArray(cell.content)) return { ...cell, content: rewriteInlineList(cell.content, opts) };
      return cell;
    });
    return { ...row, cells };
  });
  return { ...content, rows };
}

function rewriteBlock(block: unknown, opts: PublicRewriteOptions): Json | null {
  if (!isObject(block)) return null;
  const out: Json = { ...block };

  if (isObject(block.props) && typeof block.props.url === "string") {
    out.props = { ...block.props, url: rewriteFileUrl(block.props.url, opts.token) };
  }
  if (Array.isArray(block.content)) {
    out.content = rewriteInlineList(block.content, opts);
  } else if (isObject(block.content) && block.content.type === "tableContent") {
    out.content = rewriteTable(block.content, opts);
  }
  if (Array.isArray(block.children)) {
    out.children = rewriteBlocks(block.children, opts);
  }
  return out;
}

export function rewriteBlocks(blocks: readonly unknown[], opts: PublicRewriteOptions): Json[] {
  const out: Json[] = [];
  for (const block of blocks) {
    const rewritten = rewriteBlock(block, opts);
    if (rewritten) out.push(rewritten);
  }
  return out;
}

/** Entry point for the public page. Returns BlockNote-ready partial blocks. */
export function rewritePublicBlocks(blocks: readonly unknown[], opts: PublicRewriteOptions): HPartialBlock[] {
  // The JSON came from BlockNote itself (collab extraction); BlockNote validates it again on load.
  return rewriteBlocks(blocks, { ...opts, allowedPageIds: normalizeIds(opts.allowedPageIds) }) as unknown as HPartialBlock[];
}

function normalizeIds(ids: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...ids].map((id) => id.toLowerCase()));
}
