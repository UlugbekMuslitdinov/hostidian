import type { HBlock } from "../schema";
import { forEachInlineArray, type LooseBlock, type LooseInline } from "../loose";
import { isPageId } from "./tokens";

function collectLinks(items: LooseInline[], seen: Set<string>, out: string[]): void {
  for (const item of items) {
    if (item.type === "pageLink") {
      const id = item.props?.pageId;
      if (isPageId(id)) {
        const normalized = id.toLowerCase();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
      }
    } else if (item.content) {
      collectLinks(item.content, seen, out);
    }
  }
}

function walk(blocks: LooseBlock[], seen: Set<string>, out: string[]): void {
  for (const block of blocks) {
    forEachInlineArray(block, (items) => collectLinks(items, seen, out));
    if (block.children?.length) walk(block.children, seen, out);
  }
}

/** Distinct page ids referenced by `pageLink` nodes (lower-cased), in document order. Malformed ids are ignored. */
export function extractPageLinkIds(blocks: HBlock[]): string[] {
  const out: string[] = [];
  walk(blocks as LooseBlock[], new Set(), out);
  return out;
}
