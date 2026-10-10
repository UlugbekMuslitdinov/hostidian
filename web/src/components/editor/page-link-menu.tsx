"use client";

import { SuggestionMenuController, type DefaultReactSuggestionItem } from "@blocknote/react";
import { FilePlus2, FileText, Plus } from "lucide-react";
import type { PageSummary } from "@hostidian/api-types";
import { cleanNewPageTitle, parentPath, rankPages, shouldOfferCreate } from "./page-link-search";
import type { HEditor } from "./editor-types";

/** Small document glyph mirroring the chip rendered by `pageLinkSpec`. */
function PageGlyph({ icon }: { icon?: string | null }) {
  if (icon) return <span className="text-base leading-none">{icon}</span>;
  return <FileText className="size-[18px]" aria-hidden="true" />;
}

export interface PageLinkMenuProps {
  editor: HEditor;
  pages: readonly PageSummary[];
  /** The page being edited: never offered as a link to itself. */
  currentPageId: string;
  /** Create a page with the typed title and return its id (client-generated, offline-safe). */
  onCreate: (title: string) => string | undefined;
}

/**
 * The `[[` page picker. Runs entirely on the cached tree (offline, no round trip per keystroke) and offers
 * "Create page" when the typed title doesn't already exist. Must be rendered inside the `<BlockNoteView>`.
 */
export function PageLinkMenu({ editor, pages, currentPageId, onCreate }: PageLinkMenuProps) {
  const getItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const pagesArray = pages as PageSummary[];
    const items: DefaultReactSuggestionItem[] = rankPages(pagesArray, query, { excludeId: currentPageId }).map((page) => {
      const path = parentPath(pagesArray, page);
      return {
        title: page.title.trim() || "Untitled",
        subtext: path || undefined,
        group: "Link to page",
        icon: <PageGlyph icon={page.icon} />,
        onItemClick: () => {
          editor.insertInlineContent([{ type: "pageLink", props: { pageId: page.id, title: page.title } }, " "]);
        },
      };
    });

    if (shouldOfferCreate(pagesArray, query)) {
      const title = cleanNewPageTitle(query);
      if (title) {
        // Last, so that Enter on `[[Tar` links the existing "Target" instead of silently creating a page named "Tar".
        items.push({
          title: `Create “${title}”`,
          subtext: "New page",
          group: "Create",
          icon: <Plus className="size-[18px]" aria-hidden="true" />,
          onItemClick: () => {
            const id = onCreate(title);
            if (id) {
              editor.insertInlineContent([{ type: "pageLink", props: { pageId: id, title } }, " "]);
            }
          },
        });
      }
    }

    return items;
  };

  return <SuggestionMenuController triggerCharacter="[[" minQueryLength={0} getItems={getItems} />;
}

/** Used by the slash menu's "Link to page" entry to point users at the `[[` trigger. */
export const PAGE_LINK_ICON = <FilePlus2 className="size-[18px]" aria-hidden="true" />;
