"use client";

import { useQuery } from "@tanstack/react-query";
import { CornerLeftUp } from "lucide-react";
import { useMemo } from "react";
import { PageIcon } from "@/components/common/page-icon";
import { useAppUI } from "@/components/layout/app-ui";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { usePageActions } from "@/hooks/use-page-actions";
import { pagesOptions } from "@/lib/api/queries";
import { canEdit } from "@/lib/permissions";
import { ancestorPages, buildTree, descendantIds } from "@/lib/tree";
import { pageTitle } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

const MAX_ITEMS = 300;

/** "Move to…" page picker. Mounted once in the app shell; opened via `useAppUI().openMovePage(id)`. */
export function MovePageDialog() {
  const { movePageId, closeMovePage } = useAppUI();
  return (
    <Dialog open={movePageId !== null} onOpenChange={(open) => !open && closeMovePage()}>
      <DialogContent showClose={false} className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
        {movePageId ? <MovePicker pageId={movePageId} onDone={closeMovePage} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function MovePicker({ pageId, onDone }: { pageId: string; onDone: () => void }) {
  const { workspace } = useWorkspace();
  const actions = usePageActions();
  const { data: pages = [] } = useQuery(pagesOptions(workspace.id));

  const { page, targets } = useMemo(() => {
    const tree = buildTree(pages);
    const moving = tree.byId.get(pageId)?.page;
    const blocked = new Set([pageId, ...descendantIds(tree, pageId)]);
    const list = pages
      .filter((p) => !blocked.has(p.id) && p.id !== moving?.parentId && canEdit(p.role))
      .slice(0, MAX_ITEMS)
      .map((p) => ({
        page: p,
        path: ancestorPages(tree, p.id)
          .map((a) => pageTitle(a.title))
          .join(" / "),
      }));
    return { page: moving, targets: list };
  }, [pages, pageId]);

  const choose = (parentId: string | null) => {
    actions.move(pageId, { parentId });
    onDone();
  };

  return (
    <>
      <DialogTitle className="sr-only">Move {page ? pageTitle(page.title) : "page"} to…</DialogTitle>
      <DialogDescription className="sr-only">Choose the page to move it into.</DialogDescription>
      <Command>
        <CommandInput placeholder={`Move ${page ? `“${pageTitle(page.title)}”` : "page"} into…`} />
        <CommandList>
          <CommandEmpty>No matching pages.</CommandEmpty>
          {page?.parentId ? (
            <CommandGroup>
              <CommandItem value="top level workspace root" onSelect={() => choose(null)}>
                <CornerLeftUp />
                <span>Move to top level</span>
              </CommandItem>
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Pages">
            {targets.map(({ page: p, path }) => (
              <CommandItem key={p.id} value={`${pageTitle(p.title)} ${path} ${p.id}`} onSelect={() => choose(p.id)}>
                <PageIcon icon={p.icon} emojiClassName="text-[15px]" />
                <span className="truncate">{pageTitle(p.title)}</span>
                {path ? <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{path}</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </>
  );
}
