"use client";

import { Copy, CopyPlus, Download, FolderInput, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import type { PageSummary } from "@hostidian/api-types";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useAppUI } from "@/components/layout/app-ui";
import { useOnline } from "@/lib/offline/context";
import type { PageActions } from "@/hooks/use-page-actions";
import { canArchive, canEdit } from "@/lib/permissions";

/**
 * Items of the page "…" menu, shared by the sidebar rows and the page header.
 * Render inside a <DropdownMenuContent>.
 */
export function PageMenuItems({
  page,
  isFavorite,
  actions,
  onRename,
}: {
  page: Pick<PageSummary, "id" | "title" | "role">;
  isFavorite: boolean;
  actions: PageActions;
  /** Provide to show "Rename" (sidebar rows rename inline; the header edits the title in place). */
  onRename?: () => void;
}) {
  const ui = useAppUI();
  const online = useOnline();
  const editable = canEdit(page.role);
  // Duplicating and exporting are server-side operations.
  const needsConnection = online ? null : <span className="ml-auto text-xs text-muted-foreground">Needs connection</span>;

  return (
    <>
      <DropdownMenuItem onSelect={() => actions.setFavorite(page.id, !isFavorite)}>
        {isFavorite ? <StarOff /> : <Star />}
        {isFavorite ? "Remove from favorites" : "Add to favorites"}
      </DropdownMenuItem>
      {onRename && editable ? (
        <DropdownMenuItem onSelect={onRename}>
          <Pencil />
          Rename
        </DropdownMenuItem>
      ) : null}
      {editable ? (
        <DropdownMenuItem disabled={!online} onSelect={() => void actions.duplicate(page.id)}>
          <CopyPlus />
          Duplicate
          {needsConnection}
        </DropdownMenuItem>
      ) : null}
      {editable ? (
        <DropdownMenuItem onSelect={() => ui.openMovePage(page.id)}>
          <FolderInput />
          Move to…
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => void actions.copyLink(page.id)}>
        <Copy />
        Copy link
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!online} onSelect={() => void actions.exportPage(page.id, page.title)}>
        <Download />
        Export as Markdown
        {needsConnection}
      </DropdownMenuItem>
      {canArchive(page.role) ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => actions.archive(page.id)}>
            <Trash2 />
            Move to Trash
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}
