"use client";

import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";
import "@hostidian/editor-schema/styles.css";
import "./editor.css";

import { withCollaboration } from "@blocknote/core/yjs";
import { FormattingToolbarController, SideMenuController, useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { PageLinkContext, schema, type PageLinkContextValue } from "@hostidian/editor-schema/react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { EffectiveRole } from "@hostidian/api-types";
import { collectBlockIds } from "@/components/comments/anchoring";
import type { CommentsContextValue } from "@/components/comments/comments-context";
import { useComments } from "@/components/comments/comments-context";
import { ThreadBadges } from "@/components/comments/thread-badges";
import { usePublishConnection, usePublishPresence } from "@/components/page/presence";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageActions } from "@/hooks/use-page-actions";
import { githubIssuesOptions, pagesOptions } from "@/lib/api/queries";
import { buildIssueIndex } from "@/lib/github";
import { CONNECTION_LABELS, type ConnectionState } from "@/lib/collab/connection";
import type { CollabSession } from "@/lib/collab/session";
import { usePageCollab, usePeers } from "@/lib/collab/use-page-collab";
import { attachmentUrl, describeUploadError, uploadAttachment } from "@/lib/files/upload";
import { useAppNavigate } from "@/lib/nav";
import { canEdit } from "@/lib/permissions";
import { useSession } from "@/lib/session";
import { pageHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { CommentFormattingToolbar } from "./comment-toolbar-button";
import { ReadOnlyCommentOverlay } from "./comment-overlay";
import { CommentSideMenu } from "./comment-side-menu";
import { PageLinkMenu } from "./page-link-menu";
import { SlashMenu } from "./slash-menu";
import { usePageLinkIndex } from "./use-page-link-index";

/**
 * The page body editor: BlockNote bound to the page's Y.Doc (collaboration + offline via y-indexeddb),
 * with page links, uploads, presence and block-anchored comments. Read-only roles still get the editor
 * (they can select text and comment), just not an editable one.
 */
export function PageEditor({ pageId, role }: { pageId: string; role: EffectiveRole }) {
  const { user } = useSession();
  const { session, snapshot } = usePageCollab(pageId, { id: user.id, name: user.name, color: user.avatarColor });
  const peers = usePeers(session, user.id);
  usePublishPresence(peers);
  usePublishConnection(snapshot.connection);
  const comments = useComments();

  const editable = canEdit(role) && snapshot.connection !== "no-access";

  if (!session || !snapshot.localReady) {
    return <EditorLoading connection={snapshot.connection} />;
  }

  return (
    <CollabEditor
      key={session.documentName}
      session={session}
      pageId={pageId}
      editable={editable}
      comments={comments}
      contentReady={snapshot.contentReady}
    />
  );
}

function CollabEditor({
  session,
  pageId,
  editable,
  comments,
  contentReady,
}: {
  session: CollabSession;
  pageId: string;
  editable: boolean;
  comments: CommentsContextValue | null;
  contentReady: boolean;
}) {
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const navigate = useAppNavigate();
  const { createPage } = usePageActions();
  const pageLinkIndex = usePageLinkIndex(workspace.id);
  const pages = useQuery(pagesOptions(workspace.id)).data ?? [];
  const issueRefs = useQuery(githubIssuesOptions(workspace.id)).data;
  const issues = useMemo(() => buildIssueIndex(issueRefs), [issueRefs]);
  const resolvedTheme = useTheme().resolvedTheme;
  const wrapperRef = useRef<HTMLDivElement>(null);

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      uploadFile: async (file) => {
        try {
          const attachment = await uploadAttachment({ workspaceId: workspace.id, pageId, file });
          return attachmentUrl(attachment);
        } catch (error) {
          toast.error("Couldn't upload the file", { description: describeUploadError(error) });
          throw error;
        }
      },
      collaboration: {
        fragment: session.fragment,
        user: { id: user.id, name: user.name, color: user.avatarColor },
        provider: { awareness: session.awareness },
      },
    }),
    [session.doc],
  );

  // The local user's awareness entry, in case the server doesn't stamp it (conventions §6).
  useEffect(() => {
    session.awareness.setLocalStateField("user", { id: user.id, name: user.name, color: user.avatarColor });
  }, [session, user.id, user.name, user.avatarColor]);

  const publishBlocks = useCallback(() => {
    comments?.publishBlocks(collectBlockIds(editor.document));
  }, [comments, editor]);

  useEffect(() => {
    publishBlocks();
  }, [publishBlocks]);

  useEffect(() => {
    comments?.setContentReady(contentReady);
  }, [comments, contentReady]);

  const pageLinkValue = useMemo<PageLinkContextValue>(
    () => ({
      resolve: (id) => pageLinkIndex.get(id.toLowerCase()),
      onNavigate: (id) => navigate(pageHref(workspace.slug, id)),
    }),
    [pageLinkIndex, navigate, workspace.slug],
  );

  const onCreatePage = useCallback((title: string) => createPage({ title, navigate: false }), [createPage]);

  return (
    <PageLinkContext.Provider value={pageLinkValue}>
      <div ref={wrapperRef} className="relative">
        <BlockNoteView
          editor={editor}
          editable={editable}
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          slashMenu={false}
          sideMenu={false}
          formattingToolbar={false}
          onChange={publishBlocks}
          className="hostidian-editor"
        >
          <SlashMenu editor={editor} />
          <PageLinkMenu editor={editor} pages={pages} currentPageId={pageId} onCreate={onCreatePage} issues={issues} />
          <SideMenuController sideMenu={CommentSideMenu} />
          <FormattingToolbarController formattingToolbar={CommentFormattingToolbar} />
        </BlockNoteView>

        {!editable ? <ReadOnlyCommentOverlay editor={editor} wrapperRef={wrapperRef} /> : null}

        <ThreadBadges editor={editor} wrapperRef={wrapperRef} />
      </div>
    </PageLinkContext.Provider>
  );
}

function EditorLoading({ connection }: { connection: ConnectionState }) {
  return (
    <div className="mt-2" aria-busy="true" aria-label="Loading editor">
      <Skeleton className="mb-3 h-4 w-full" />
      <Skeleton className="mb-3 h-4 w-11/12" />
      <Skeleton className="h-4 w-3/5" />
      {connection === "offline" || connection === "error" || connection === "no-access" ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {CONNECTION_LABELS[connection]}
        </p>
      ) : null}
    </div>
  );
}
