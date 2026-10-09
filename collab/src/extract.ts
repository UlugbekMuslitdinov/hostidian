import { createHash } from "node:crypto";
import type * as Y from "yjs";
import { blocksToMarkdown, blocksToPlaintext, extractPageLinkIds, yDocToBlocks } from "@hostidian/editor-schema";

/** Body of `PUT /internal/pages/{id}/content` minus `editorIds` (api/internal.yaml). */
export interface ExtractedContent {
  markdown: string;
  plaintext: string;
  blocks: unknown[];
  linkTargets: string[];
}

/**
 * Document -> everything the API derives search, backlinks, export and public pages from. Reads a copy of `doc`
 * (see `yDocToBlocks`), synchronously snapshotting it before the first await, so it is safe to call on a live doc and
 * to keep running after the doc is unloaded.
 */
export async function extractContent(doc: Y.Doc): Promise<ExtractedContent> {
  const blocks = await yDocToBlocks(doc);
  const markdown = await blocksToMarkdown(blocks);
  return {
    markdown,
    plaintext: blocksToPlaintext(blocks),
    // Exactly what goes over the wire: BlockNote leaves `undefined` placeholders (e.g. table column widths) that JSON
    // turns into nulls or drops, and the content hash must not depend on that difference.
    blocks: JSON.parse(JSON.stringify(blocks)) as unknown[],
    linkTargets: extractPageLinkIds(blocks),
  };
}

/** Stable digest of the extracted content, used to skip pushes when nothing visible changed. */
export function contentHash(content: ExtractedContent): string {
  return createHash("sha256")
    .update(JSON.stringify([content.markdown, content.plaintext, content.blocks, content.linkTargets]))
    .digest("hex");
}
