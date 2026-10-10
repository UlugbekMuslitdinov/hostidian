"use client";

import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
  SuggestionMenu as SuggestionMenuExtension,
} from "@blocknote/core/extensions";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useExtension,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { Link2, Sparkles } from "lucide-react";
import type { HEditor } from "./editor-types";
import { groupContiguously } from "./slash-items";

/**
 * The `/` slash menu: BlockNote's defaults plus our custom `callout` block and a shortcut that opens the
 * `[[` page picker. Must be rendered inside the `<BlockNoteView>`.
 */
export function SlashMenu({ editor }: { editor: HEditor }) {
  const suggestionMenu = useExtension(SuggestionMenuExtension);

  const getItems = async (query: string): Promise<DefaultReactSuggestionItem[]> => {
    const items: DefaultReactSuggestionItem[] = [
      ...getDefaultReactSlashMenuItems(editor),
      {
        title: "Callout",
        subtext: "Make it stand out",
        group: "Basic blocks",
        aliases: ["callout", "note", "tip", "warning", "danger", "info"],
        icon: <Sparkles className="size-[18px]" aria-hidden="true" />,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "callout", props: { kind: "note" } });
        },
      },
      {
        title: "Link to page",
        subtext: "Reference another page",
        group: "Advanced",
        aliases: ["link", "page", "wiki", "reference", "[["],
        icon: <Link2 className="size-[18px]" aria-hidden="true" />,
        onItemClick: () => suggestionMenu.openSuggestionMenu("[["),
      },
    ];
    return groupContiguously(filterSuggestionItems(items, query));
  };

  return <SuggestionMenuController triggerCharacter="/" getItems={getItems} />;
}
