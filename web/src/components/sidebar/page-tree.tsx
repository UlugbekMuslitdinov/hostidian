"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { ChevronRight, Lock, Plus, Star, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PageIcon } from "@/components/common/page-icon";
import { PageMenuItems } from "@/components/page/page-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePageActions } from "@/hooks/use-page-actions";
import { canCreateTopLevelPage } from "@/lib/permissions";
import { AppLink, useAppNavigate, useRoute } from "@/lib/nav";
import { useSession } from "@/lib/session";
import {
  ancestorIds,
  buildTree,
  flattenVisible,
  moveWithinSiblings,
  resolveDrop,
  resolveDropAtEnd,
  type DropPosition,
  type FlatItem,
  type SectionId,
} from "@/lib/tree";
import { cn, pageHref, pageTitle } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PageSummary } from "@hostidian/api-types";
import { rowDomId, TreeRow } from "./tree-row";
import { useCollapsedSections, useExpandedIds } from "./use-tree-state";

// Keep the drag chip beside the pointer so it doesn't cover the row being targeted.
const hangBelowPointer: Modifier = ({ transform }) => ({ ...transform, x: transform.x + 14, y: transform.y + 22 });

interface DropState {
  overId: string;
  position: DropPosition;
}

const END_PREFIX = "end:";

/**
 * Favorites + Workspace/Private/Shared page trees. Keyed by workspace id by the parent so per-workspace
 * state (expanded rows, rename) resets on switch.
 */
export function PageTree({ pages, favorites }: { pages: readonly PageSummary[]; favorites: readonly PageSummary[] }) {
  const { workspace, role } = useWorkspace();
  const { user } = useSession();
  const navigate = useAppNavigate();
  const route = useRoute();
  const activeId = route.kind === "page" ? route.pageId : undefined;
  const actions = usePageActions();

  const tree = useMemo(() => buildTree(pages, { userId: user.id }), [pages, user.id]);
  const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);
  const { expanded, toggle, expand, collapse } = useExpandedIds(user.id, workspace.id);
  const { collapsed: collapsedSections, toggle: toggleSection } = useCollapsedSections(user.id);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const pointerY = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reveal the open page: expand its ancestors once per navigation (derived state, no effect needed).
  const revealMarker = activeId && tree.byId.has(activeId) ? activeId : null;
  const [revealed, setRevealed] = useState<string | null>(null);
  if (revealMarker !== revealed) {
    setRevealed(revealMarker);
    if (revealMarker) expand(ancestorIds(tree, revealMarker));
  }

  const sections = useMemo(
    () => ({
      workspace: flattenVisible(tree.roots.workspace, expanded, "workspace"),
      private: flattenVisible(tree.roots.private, expanded, "private"),
      shared: flattenVisible(tree.roots.shared, expanded, "shared"),
    }),
    [tree, expanded],
  );

  const visibleIds = useMemo(
    () => [...sections.workspace, ...sections.private, ...sections.shared].map((i) => i.id),
    [sections],
  );
  const tabbableId =
    focusedId && visibleIds.includes(focusedId)
      ? focusedId
      : activeId && visibleIds.includes(activeId)
        ? activeId
        : (visibleIds[0] ?? null);

  const canCreateRoot = canCreateTopLevelPage(role);

  // ------------------------------------------------------------------ drag and drop

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
  );

  useEffect(() => {
    if (!dragId) return;
    const onMouse = (e: MouseEvent) => {
      pointerY.current = e.clientY;
    };
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) pointerY.current = t.clientY;
    };
    window.addEventListener("mousemove", onMouse, { passive: true });
    window.addEventListener("touchmove", onTouch, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("touchmove", onTouch);
    };
  }, [dragId]);

  const computeDrop = (overId: string | undefined, activeDragId: string | null): DropState | null => {
    if (!overId || !activeDragId) return null;
    if (overId.startsWith(END_PREFIX)) return { overId, position: "after" };
    const el = document.getElementById(rowDomId(overId));
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const ratio = rect.height > 0 ? (pointerY.current - rect.top) / rect.height : 0.5;
    const position: DropPosition = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : "inside";
    return { overId, position };
  };

  const targetFor = (state: DropState | null, activeDragId: string | null) => {
    if (!state || !activeDragId) return null;
    if (state.overId.startsWith(END_PREFIX)) {
      return resolveDropAtEnd(tree, activeDragId, state.overId.slice(END_PREFIX.length) as SectionId);
    }
    return resolveDrop(tree, { activeId: activeDragId, overId: state.overId, position: state.position });
  };

  const onDragStart = (event: DragStartEvent) => {
    setDragId(String(event.active.id));
    const origin = event.activatorEvent as MouseEvent | TouchEvent;
    pointerY.current = "touches" in origin ? (origin.touches[0]?.clientY ?? 0) : origin.clientY;
  };

  const onDragMove = (event: DragMoveEvent) => {
    const next = computeDrop(event.over ? String(event.over.id) : undefined, dragId);
    setDrop((prev) => (prev?.overId === next?.overId && prev?.position === next?.position ? prev : next));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeDragId = String(event.active.id);
    const state = computeDrop(event.over ? String(event.over.id) : undefined, activeDragId) ?? drop;
    const target = targetFor(state, activeDragId);
    setDragId(null);
    setDrop(null);
    if (!target) return;
    actions.move(activeDragId, target);
    if (target.parentId) expand([target.parentId]);
  };

  const cancelDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  const dropIndicator = (rowId: string): DropPosition | null => {
    if (!drop || drop.overId !== rowId || !dragId) return null;
    return targetFor(drop, dragId) ? drop.position : null;
  };

  // ------------------------------------------------------------------ keyboard

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    document.getElementById(rowDomId(id))?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [role='menu']")) return;
    const row = target.closest<HTMLElement>("[data-tree-row]");
    if (!row || e.target !== row) return;
    const id = row.dataset.itemId;
    if (!id) return;
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-tree-row]") ?? []);
    const index = rows.indexOf(row);
    const hasChildren = row.dataset.hasChildren === "true";
    const isExpanded = row.dataset.expanded === "true";

    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const moveTarget = moveWithinSiblings(tree, id, e.key === "ArrowUp" ? -1 : 1);
      if (moveTarget) {
        actions.move(id, moveTarget);
        requestAnimationFrame(() => focusRow(id));
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(rows[index + 1]?.dataset.itemId);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(rows[index - 1]?.dataset.itemId);
        break;
      case "Home":
        e.preventDefault();
        focusRow(rows[0]?.dataset.itemId);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows[rows.length - 1]?.dataset.itemId);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (hasChildren && !isExpanded) expand([id]);
        else if (hasChildren) focusRow(rows[index + 1]?.dataset.itemId);
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (hasChildren && isExpanded) collapse(id);
        else if (row.dataset.parentId) focusRow(row.dataset.parentId);
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        navigate(pageHref(workspace.slug, id));
        break;
      case "F2":
        e.preventDefault();
        setRenamingId(id);
        break;
      case "ContextMenu":
        e.preventDefault();
        setMenuId(id);
        break;
      case "F10":
        if (e.shiftKey) {
          e.preventDefault();
          setMenuId(id);
        }
        break;
      default:
        break;
    }
  };

  // ------------------------------------------------------------------ render

  const renderRows = (items: FlatItem[], draggable: boolean): ReactNode =>
    items.map((item) => (
      <TreeRow
        key={item.id}
        item={item}
        workspaceSlug={workspace.slug}
        active={item.id === activeId}
        tabbable={item.id === tabbableId}
        isFavorite={favoriteIds.has(item.id)}
        draggable={draggable}
        renaming={renamingId === item.id}
        menuOpen={menuId === item.id}
        dropState={dropIndicator(item.id)}
        actions={actions}
        onToggle={toggle}
        onAddChild={(parentId) => {
          expand([parentId]);
          actions.createPage({ parentId });
        }}
        onStartRename={setRenamingId}
        onCommitRename={(id, title) => {
          setRenamingId(null);
          const current = tree.byId.get(id)?.page.title ?? "";
          if (title !== current) actions.rename(id, title);
          requestAnimationFrame(() => focusRow(id));
        }}
        onCancelRename={() => {
          const id = renamingId;
          setRenamingId(null);
          requestAnimationFrame(() => focusRow(id ?? undefined));
        }}
        onMenuOpenChange={(id, open) => setMenuId(open ? id : null)}
        onFocusRow={setFocusedId}
      />
    ));

  const draggedPage = dragId ? tree.byId.get(dragId)?.page : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={cancelDrag}
    >
      <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col gap-3 pb-4">
        {favorites.length > 0 && (
          <SidebarSection
            id="favorites"
            label="Favorites"
            icon={<Star className="size-3.5" />}
            collapsed={collapsedSections.has("favorites")}
            onToggle={toggleSection}
          >
            <ul className="flex flex-col gap-px" aria-label="Favorites">
              {favorites.map((page) => (
                <FavoriteRow
                  key={page.id}
                  page={page}
                  slug={workspace.slug}
                  active={page.id === activeId}
                  actions={actions}
                />
              ))}
            </ul>
          </SidebarSection>
        )}

        {(canCreateRoot || sections.workspace.length > 0) && (
          <SidebarSection
            id="workspace"
            label="Workspace"
            icon={<Users className="size-3.5" />}
            collapsed={collapsedSections.has("workspace")}
            onToggle={toggleSection}
            onAdd={canCreateRoot ? () => actions.createPage({ parentId: null, visibility: "workspace" }) : undefined}
            addLabel="New workspace page"
          >
            <div role="tree" aria-label="Workspace pages" className="flex flex-col gap-px">
              {renderRows(sections.workspace, true)}
            </div>
            {sections.workspace.length === 0 && (
              <EmptyHint>
                {canCreateRoot ? "No pages yet. Create the first one." : "Nothing shared with you yet."}
              </EmptyHint>
            )}
            <EndDropZone
              section="workspace"
              active={dragId !== null}
              highlighted={drop?.overId === `${END_PREFIX}workspace`}
            />
          </SidebarSection>
        )}

        {canCreateRoot && (
          <SidebarSection
            id="private"
            label="Private"
            icon={<Lock className="size-3.5" />}
            collapsed={collapsedSections.has("private")}
            onToggle={toggleSection}
            onAdd={() => actions.createPage({ parentId: null, visibility: "private" })}
            addLabel="New private page"
          >
            <div role="tree" aria-label="Private pages" className="flex flex-col gap-px">
              {renderRows(sections.private, true)}
            </div>
            {sections.private.length === 0 && <EmptyHint>Pages only you can see.</EmptyHint>}
            <EndDropZone
              section="private"
              active={dragId !== null}
              highlighted={drop?.overId === `${END_PREFIX}private`}
            />
          </SidebarSection>
        )}

        {sections.shared.length > 0 && (
          <SidebarSection
            id="shared"
            label="Shared with me"
            icon={<Users className="size-3.5" />}
            collapsed={collapsedSections.has("shared")}
            onToggle={toggleSection}
          >
            <div role="tree" aria-label="Pages shared with you" className="flex flex-col gap-px">
              {renderRows(sections.shared, false)}
            </div>
          </SidebarSection>
        )}
      </div>

      <DragOverlay dropAnimation={null} modifiers={[hangBelowPointer]} style={{ width: "max-content", height: "auto" }}>
        {draggedPage ? (
          <div className="flex max-w-[240px] items-center gap-1.5 rounded-md border bg-popover px-2.5 py-1.5 text-sm shadow-popover">
            <PageIcon icon={draggedPage.icon} emojiClassName="text-[15px]" />
            <span className="truncate">{pageTitle(draggedPage.title)}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function SidebarSection({
  id,
  label,
  icon,
  collapsed,
  onToggle,
  onAdd,
  addLabel,
  children,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  onToggle: (id: string) => void;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label}>
      <div className="group/section flex items-center pr-1 pl-1">
        <button
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={!collapsed}
          className="flex min-h-11 flex-1 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent md:min-h-6"
        >
          <ChevronRight className={cn("size-3 transition-transform", !collapsed && "rotate-90")} />
          {icon}
          <span>{label}</span>
        </button>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel}
            className="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground md:size-6 md:opacity-0 md:focus-visible:opacity-100 md:group-focus-within/section:opacity-100 md:group-hover/section:opacity-100"
          >
            <Plus className="size-4" />
          </button>
        )}
      </div>
      {!collapsed && <div className="mt-0.5 px-1">{children}</div>}
    </section>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>;
}

/**
 * A thin, always-present strip after the last top-level page of a section ("make it the last one").
 * It never changes size while dragging, so rows don't jump under the pointer.
 */
function EndDropZone({ section, active, highlighted }: { section: SectionId; active: boolean; highlighted: boolean }) {
  const { setNodeRef } = useDroppable({ id: `${END_PREFIX}${section}`, disabled: !active });
  return (
    <div ref={setNodeRef} aria-hidden="true" className="relative mt-0.5 h-2">
      <div
        className={cn(
          "absolute inset-x-1 top-0.5 h-0.5 rounded-full bg-transparent transition-colors",
          highlighted && "bg-ring",
        )}
      />
    </div>
  );
}

function FavoriteRow({
  page,
  slug,
  active,
  actions,
}: {
  page: PageSummary;
  slug: string;
  active: boolean;
  actions: ReturnType<typeof usePageActions>;
}) {
  return (
    <li
      className={cn(
        "group/fav flex min-h-11 items-center rounded-md pr-1 text-[14px] text-sidebar-foreground/85 hover:bg-sidebar-accent md:min-h-[30px]",
        active && "bg-sidebar-accent font-medium text-sidebar-foreground",
      )}
    >
      <AppLink
        href={pageHref(slug, page.id)}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md py-1 pl-2.5 -outline-offset-2"
      >
        <PageIcon icon={page.icon} emojiClassName="w-5 text-[15px]" className="mx-0.5 size-[18px]" />
        <span className="truncate">{pageTitle(page.title)}</span>
      </AppLink>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${pageTitle(page.title)}`}
            className="grid h-full w-9 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 group-hover/fav:opacity-100 data-[state=open]:opacity-100 md:size-6 md:h-6 [@media(hover:none)]:opacity-100"
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <PageMenuItems page={page} isFavorite actions={actions} />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
