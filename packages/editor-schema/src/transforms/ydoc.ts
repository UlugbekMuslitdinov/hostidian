import * as Y from "yjs";
import { YDOC_FRAGMENT } from "../constants";
import type { HBlock } from "../schema";
import { blocksToYDoc, blocksToYXmlFragment, yDocToBlocks as coreYDocToBlocks } from "@blocknote/core/yjs";
import { getCoreEditor } from "./dom-editor";

/**
 * Reads the document's blocks. Works on a throwaway copy of the doc: y-prosemirror repairs invalid structure while
 * reading (it may delete nodes and merge adjacent Y.Text), and a read must never write to a live, shared document.
 */
export async function yDocToBlocks(doc: Y.Doc): Promise<HBlock[]> {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    return coreYDocToBlocks(getCoreEditor(), copy, YDOC_FRAGMENT) as unknown as HBlock[];
  } finally {
    copy.destroy();
  }
}

/** Encodes `blocks` as the full state of a brand-new Y.Doc (no shared history with any existing document). */
export async function blocksToYDocUpdate(blocks: HBlock[]): Promise<Uint8Array> {
  const doc = blocksToYDoc(getCoreEditor(), blocks as never, YDOC_FRAGMENT);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Replaces the content of an existing (possibly live, shared) doc with `blocks` as a minimal diff inside one
 * transaction, so connected clients receive an ordinary update rather than a conflicting parallel history.
 */
export function replaceYDocBlocks(doc: Y.Doc, blocks: HBlock[]): void {
  doc.transact(() => {
    blocksToYXmlFragment(getCoreEditor(), blocks as never, doc.getXmlFragment(YDOC_FRAGMENT));
  });
}
