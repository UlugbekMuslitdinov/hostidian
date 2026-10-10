"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";
import "@hostidian/editor-schema/styles.css";
import "@/components/editor/editor.css";

import { useTheme } from "next-themes";
import { useMemo } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { PageLinkContext, schema, type HPartialBlock, type PageLinkInfo } from "@hostidian/editor-schema/react";
import type { PublicPage } from "@hostidian/api-types";
import { rewritePublicBlocks } from "@/lib/files/public-blocks";

/**
 * Read-only BlockNote renderer for a public page. There is no collaboration here: the editor is built
 * once from the stored `blocks` JSON (`rewritePublicBlocks` rewrites file URLs and flattens links that
 * point outside the share) with the same shared schema the app uses. Mounted only after the page data
 * has loaded, so mounting is always client-side (no hydration mismatch).
 */
export function PublicBlocks({
  blocks,
  token,
  allowedPageIds,
  titles,
  onNavigate,
}: {
  blocks: PublicPage["blocks"];
  token: string;
  allowedPageIds: ReadonlySet<string>;
  titles: ReadonlyMap<string, PageLinkInfo>;
  onNavigate: (pageId: string) => void;
}) {
  const initialContent = useMemo<HPartialBlock[]>(
    () => rewritePublicBlocks(blocks, { token, allowedPageIds }),
    [blocks, token, allowedPageIds],
  );

  // No collaboration: the editor is built once from the stored content. The parent remounts this
  // component (via `key`) when navigating to another shared page.
  // BlockNote refuses an empty `initialContent` array (a page nobody has written in yet), so give it none.
  const editor = useCreateBlockNote({ schema, initialContent: initialContent.length > 0 ? initialContent : undefined }, []);
  const resolvedTheme = useTheme().resolvedTheme;

  return (
    <PageLinkContext.Provider value={{ resolve: (id) => titles.get(id.toLowerCase()), onNavigate }}>
      <BlockNoteView editor={editor} editable={false} theme={resolvedTheme === "dark" ? "dark" : "light"} className="hostidian-editor" />
    </PageLinkContext.Provider>
  );
}
