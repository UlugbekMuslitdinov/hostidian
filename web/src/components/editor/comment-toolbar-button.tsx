"use client";

import { FormattingToolbar, getFormattingToolbarItems, useBlockNoteEditor, useComponentsContext } from "@blocknote/react";
import { MessageSquarePlus } from "lucide-react";
import { quoteFor } from "@/components/comments/anchoring";
import { blockText } from "@/components/comments/block-text";
import { useComments } from "@/components/comments/comments-context";

/** "Comment" on the text selection: the block-anchored thread, quoting what is selected. */
function CommentSelectionButton() {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  const comments = useComments();
  if (!Components || !comments?.canComment) return null;

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      label="Add comment"
      mainTooltip="Add comment"
      icon={<MessageSquarePlus size={18} />}
      onClick={() => {
        const selection = editor.getSelection();
        const block = selection?.blocks[0] ?? editor.getTextCursorPosition().block;
        comments.startThread({
          blockId: block.id,
          quote: quoteFor(editor.getSelectedText(), blockText(block)),
        });
      }}
    />
  );
}

/**
 * BlockNote's default formatting toolbar plus a comment button. It is what makes commenting reachable on touch
 * screens, where there is no hover to reveal the side menu: select text, tap the comment button.
 */
export function CommentFormattingToolbar() {
  return (
    <FormattingToolbar>
      {getFormattingToolbarItems()}
      <CommentSelectionButton key="comment" />
    </FormattingToolbar>
  );
}
