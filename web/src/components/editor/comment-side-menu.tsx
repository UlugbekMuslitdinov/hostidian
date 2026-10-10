"use client";

import { SideMenuExtension } from "@blocknote/core/extensions";
import {
  AddBlockButton,
  DragHandleButton,
  SideMenu,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
  type SideMenuProps,
} from "@blocknote/react";
import { MessageSquarePlus } from "lucide-react";
import { quoteFor } from "@/components/comments/anchoring";
import { blockText } from "@/components/comments/block-text";
import { useComments } from "@/components/comments/comments-context";

/**
 * The block side menu (add / drag / comment). The comment button starts a thread anchored to the hovered
 * block, quoting the current selection, and opens the comments panel. Rendered via `SideMenuController`
 * so it participates in BlockNote's block hover tracking.
 */
export function CommentSideMenu(props: SideMenuProps) {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
  const comments = useComments();

  const target = comments && comments.canComment && block ? { comments, block } : null;

  return (
    <SideMenu {...props}>
      <AddBlockButton />
      <DragHandleButton dragHandleMenu={props.dragHandleMenu} />
      {target && Components ? (
        <Components.SideMenu.Button
          className="bn-button"
          label="Add comment"
          onClick={(event) => {
            event.preventDefault();
            const quote = quoteFor(editor.getSelectedText(), blockText(target.block));
            target.comments.startThread({ blockId: target.block.id, quote });
          }}
          icon={<MessageSquarePlus size={18} />}
        />
      ) : null}
    </SideMenu>
  );
}
