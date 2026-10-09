import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { markdownToBlocks, replaceYDocBlocks } from "@hostidian/editor-schema";
import { documentNameFor, type ConnectionContext } from "./auth";
import type { ContentSync } from "./content-sync";
import type { DocumentPersister } from "./persistence";

export interface ImportDeps {
  hocuspocus: Pick<Hocuspocus<ConnectionContext>, "openDirectConnection">;
  persister: DocumentPersister;
  sync: ContentSync;
}

export interface ImportRequest {
  pageId: string;
  markdown: string;
  editorId?: string;
}

/**
 * `POST /internal/import-markdown`: Markdown -> blocks -> Y.Doc, replacing whatever the page held.
 *
 * Goes through the live document (a direct connection) so clients that have the page open receive the replacement as an
 * ordinary update instead of a parallel history that would merge into duplicated content. Resolves after the database
 * write and the content push to the API both succeeded.
 */
export async function importMarkdown(deps: ImportDeps, request: ImportRequest): Promise<"imported" | "page_gone"> {
  const blocks = await markdownToBlocks(request.markdown);
  const documentName = documentNameFor(request.pageId);

  if (request.editorId) deps.sync.noteEditor(request.pageId, request.editorId);
  const connection = await deps.hocuspocus.openDirectConnection(documentName, {});
  try {
    const document = connection.document;
    if (!document) throw new Error("direct connection closed unexpectedly");
    await connection.transact((doc: Y.Doc) => replaceYDocBlocks(doc, blocks));
    const outcome = await deps.persister.persist(request.pageId, document, { wait: true });
    return outcome === "stored" ? "imported" : "page_gone";
  } finally {
    // Hocuspocus stores once more when the last connection leaves; the content is identical, so it is a cheap no-op push.
    await connection.disconnect();
  }
}
