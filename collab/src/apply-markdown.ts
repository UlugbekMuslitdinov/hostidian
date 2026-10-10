import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import {
  YDOC_FRAGMENT,
  blocksToMarkdown,
  markdownToBlocks,
  replaceYDocBlocks,
  yDocToBlocks,
  type HBlock,
} from "@hostidian/editor-schema";
import { documentNameFor, type ConnectionContext } from "./auth";
import { reuseBlockIds, type IdentifiedBlock } from "./block-ids";
import type { ContentSync } from "./content-sync";
import type { DocumentPersister } from "./persistence";

export type ApplyMode = "replace" | "append" | "prepend";

export interface ApplyDeps {
  hocuspocus: Pick<Hocuspocus<ConnectionContext>, "openDirectConnection">;
  persister: DocumentPersister;
  sync: ContentSync;
}

export interface ApplyRequest {
  pageId: string;
  markdown: string;
  mode: ApplyMode;
  editorId: string;
}

/** The Markdown could not be turned into blocks (surfaces as 422). */
export class InvalidMarkdownError extends Error {}

function isBlankParagraph(container: Y.XmlElement): boolean {
  if (container.length !== 1) return false;
  const only = container.get(0);
  return (
    only instanceof Y.XmlElement &&
    only.nodeName === "paragraph" &&
    only.toArray().every((node) => node instanceof Y.XmlText && node.length === 0)
  );
}

/** True when the document holds nothing but the empty paragraph every freshly opened page starts with. */
function isBlankDocument(group: Y.XmlElement): boolean {
  if (group.length === 0) return true;
  const first = group.get(0);
  return group.length === 1 && first instanceof Y.XmlElement && isBlankParagraph(first);
}

/** Converted blocks as detached Yjs nodes, ready to be inserted into the live document. */
function detachedBlockContainers(blocks: HBlock[]): Array<Y.XmlElement | Y.XmlText> {
  const scratch = new Y.Doc();
  try {
    replaceYDocBlocks(scratch, blocks);
    const group = scratch.getXmlFragment(YDOC_FRAGMENT).get(0);
    if (!(group instanceof Y.XmlElement)) return [];
    return group.toArray().map((node) => (node as Y.XmlElement | Y.XmlText).clone());
  } finally {
    scratch.destroy();
  }
}

function isEmptyInput(blocks: HBlock[]): boolean {
  const [only] = blocks;
  if (blocks.length === 0) return true;
  if (blocks.length !== 1 || !only) return false;
  const block = only as unknown as { type: string; content?: unknown[]; children?: unknown[] };
  return block.type === "paragraph" && (block.content?.length ?? 0) === 0 && (block.children?.length ?? 0) === 0;
}

/**
 * `POST /internal/apply-markdown`: edits a page's document through the live in-memory Y.Doc.
 *
 * Unlike the import (which replaces the stored document wholesale), the change is one ordinary Yjs transaction on the
 * document connected editors share: they see it immediately and it merges with whatever they type concurrently.
 * `append`/`prepend` insert the converted blocks without reading the existing ones, so a concurrent edit cannot be
 * overwritten; `replace` is the in-place block diff of `replaceYDocBlocks`, with the ids of unchanged blocks kept.
 * Resolves after the store and the content push to the API succeeded, with the page's resulting Markdown.
 */
export async function applyMarkdown(
  deps: ApplyDeps,
  request: ApplyRequest,
): Promise<{ status: "applied"; markdown: string } | { status: "page_gone" }> {
  let incoming: HBlock[];
  try {
    incoming = await markdownToBlocks(request.markdown);
  } catch (error) {
    throw new InvalidMarkdownError(error instanceof Error ? error.message : "The Markdown could not be parsed.");
  }
  const { pageId } = request;

  deps.sync.noteEditor(pageId, request.editorId);
  const connection = await deps.hocuspocus.openDirectConnection(documentNameFor(pageId), {});
  try {
    const document = connection.document;
    if (!document) throw new Error("direct connection closed unexpectedly");

    if (request.mode === "replace") {
      // Reading the current blocks first only decides which ids to keep; the diff below runs against the live state.
      const current = (await yDocToBlocks(document)) as unknown as IdentifiedBlock[];
      reuseBlockIds(current, incoming as unknown as IdentifiedBlock[]);
      await connection.transact((doc: Y.Doc) => replaceYDocBlocks(doc, incoming));
    } else if (!isEmptyInput(incoming)) {
      const additions = detachedBlockContainers(incoming);
      await connection.transact((doc: Y.Doc) => {
        const group = doc.getXmlFragment(YDOC_FRAGMENT).get(0);
        if (!(group instanceof Y.XmlElement) || isBlankDocument(group)) {
          replaceYDocBlocks(doc, incoming);
        } else if (request.mode === "append") {
          group.insert(group.length, additions);
        } else {
          group.insert(0, additions);
        }
      });
    }

    const markdown = await blocksToMarkdown(await yDocToBlocks(document));
    const outcome = await deps.persister.persist(pageId, document, { wait: true });
    return outcome === "stored" ? { status: "applied", markdown } : { status: "page_gone" };
  } finally {
    await connection.disconnect();
  }
}
