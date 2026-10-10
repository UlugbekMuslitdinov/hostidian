"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { PageIcon } from "@/components/common/page-icon";
import { PageMenuItems } from "@/components/page/page-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { PageActions } from "@/hooks/use-page-actions";
import { AppLink } from "@/lib/nav";
import { canEdit } from "@/lib/permissions";
import type { DropPosition, FlatItem } from "@/lib/tree";
import { cn, pageHref, pageTitle } from "@/lib/utils";

export const rowDomId = (pageId: string) => `tree-row-${pageId}`;

export interface TreeRowProps {
  item: FlatItem;
  workspaceSlug: string;
  active: boolean;
  tabbable: boolean;
  isFavorite: boolean;
  draggable: boolean;
  renaming: boolean;
  menuOpen: boolean;
  dropState: DropPosition | null;
  actions: PageActions;
  onToggle: (id: string) => void;
  onAddChild: (id: string) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, title: string) => void;
  onCancelRename: () => void;
  onMenuOpenChange: (id: string, open: boolean) => void;
  onFocusRow: (id: string) => void;
}

const actionButton =
  "grid w-9 shrink-0 self-stretch place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground md:size-6 md:h-6";

export function TreeRow(props: TreeRowProps) {
  const {
    item,
    workspaceSlug,
    active,
    tabbable,
    isFavorite,
    draggable,
    renaming,
    menuOpen,
    dropState,
    actions,
    onToggle,
    onAddChild,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onMenuOpenChange,
    onFocusRow,
  } = props;
  const { page } = item;
  const editable = canEdit(page.role);

  const {
    setNodeRef: setDragRef,
    listeners,
    isDragging,
  } = useDraggable({ id: item.id, disabled: !draggable || renaming });
  const { setNodeRef: setDropRef } = useDroppable({ id: item.id, disabled: !draggable });
  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );

  return (
    <div
      ref={setRefs}
      id={rowDomId(item.id)}
      role="treeitem"
      aria-level={item.depth + 1}
      aria-posinset={item.posInSet}
      aria-setsize={item.setSize}
      aria-expanded={item.hasChildren ? item.expanded : undefined}
      aria-selected={active}
      aria-label={pageTitle(page.title)}
      aria-keyshortcuts="F2 Alt+ArrowUp Alt+ArrowDown Shift+F10"
      tabIndex={tabbable ? 0 : -1}
      data-tree-row=""
      data-item-id={item.id}
      data-parent-id={item.parentId ?? ""}
      data-has-children={item.hasChildren}
      data-expanded={item.expanded}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusRow(item.id);
      }}
      className={cn(
        "group/row relative flex min-h-11 items-center rounded-md pr-1 text-[14px] text-sidebar-foreground/85 outline-none select-none md:min-h-[30px]",
        "hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:-outline-offset-2",
        active && "bg-sidebar-accent font-medium text-sidebar-foreground",
        isDragging && "opacity-40",
        dropState === "inside" && "bg-primary/15 ring-1 ring-inset ring-ring",
        dropState === "before" &&
          "before:pointer-events-none before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-ring",
        dropState === "after" &&
          "after:pointer-events-none after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-ring",
      )}
      style={{ paddingLeft: `${item.depth * 14 + 2}px` }}
      {...(draggable ? listeners : {})}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={item.expanded ? "Collapse" : "Expand"}
        aria-hidden={!item.hasChildren}
        disabled={!item.hasChildren}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(item.id);
        }}
        className={cn(
          "grid w-8 shrink-0 self-stretch place-items-center rounded-md text-muted-foreground hover:bg-foreground/8 disabled:pointer-events-none md:size-6 md:h-6 md:self-auto",
          !item.hasChildren && "invisible",
        )}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", item.expanded && "rotate-90")} />
      </button>

      {renaming ? (
        <RenameInput
          initial={page.title}
          icon={page.icon}
          onCommit={(title) => onCommitRename(item.id, title)}
          onCancel={onCancelRename}
        />
      ) : (
        <AppLink
          href={pageHref(workspaceSlug, item.id)}
          tabIndex={-1}
          draggable={false}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch py-1 pl-0.5 outline-none"
        >
          <PageIcon icon={page.icon} emojiClassName="w-5 text-[15px]" className="mx-0.5 size-[18px]" />
          <span className={cn("truncate", !page.title.trim() && "text-muted-foreground")}>{pageTitle(page.title)}</span>
        </AppLink>
      )}

      {!renaming && (
        <div
          className={cn(
            "flex shrink-0 items-stretch gap-0.5 self-stretch opacity-0 md:items-center md:self-auto transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
            menuOpen && "opacity-100",
          )}
        >
          <DropdownMenu open={menuOpen} onOpenChange={(open) => onMenuOpenChange(item.id, open)}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Actions for ${pageTitle(page.title)}`}
                className={actionButton}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                document.getElementById(rowDomId(item.id))?.focus();
              }}
            >
              <PageMenuItems
                page={page}
                isFavorite={isFavorite}
                actions={actions}
                onRename={() => onStartRename(item.id)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          {editable && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Add a page inside ${pageTitle(page.title)}`}
              onClick={(e) => {
                e.stopPropagation();
                onAddChild(item.id);
              }}
              className={actionButton}
            >
              <Plus className="size-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RenameInput({
  initial,
  icon,
  onCommit,
  onCancel,
}: {
  initial: string;
  icon: string | null | undefined;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? initial);
    else onCancel();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keep tree navigation shortcuts out of the text field
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pl-0.5">
      <PageIcon icon={icon} emojiClassName="w-5 text-[15px]" className="mx-0.5 size-[18px]" />
      <input
        ref={ref}
        defaultValue={initial}
        maxLength={500}
        aria-label="Page title"
        placeholder="Untitled"
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        className="h-7 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-[14px] outline-none"
      />
    </div>
  );
}
