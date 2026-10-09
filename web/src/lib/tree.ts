import type { PageSummary } from "@hostidian/api-types";

export interface TreeNode {
  page: PageSummary;
  children: TreeNode[];
}

/**
 * workspace: root pages visible to the whole workspace
 * private:   the caller's own root pages with visibility `private`
 * shared:    pages that reached the caller another way: someone else's private page shared with them,
 *            or pages whose parent the caller cannot see (e.g. a guest granted a single sub-page)
 */
export type SectionId = "workspace" | "private" | "shared";

export interface PageTree {
  byId: Map<string, TreeNode>;
  sectionById: Map<string, SectionId>;
  roots: Record<SectionId, TreeNode[]>;
}

/** Siblings sort by (position COLLATE "C", id). Fractional keys are ASCII so code-unit order == "C". */
export function comparePages(a: Pick<PageSummary, "position" | "id">, b: Pick<PageSummary, "position" | "id">): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildTreeOptions {
  /** Current user. Without it every private root counts as the caller's own. */
  userId?: string;
}

export function buildTree(pages: readonly PageSummary[], options: BuildTreeOptions = {}): PageTree {
  const byId = new Map<string, TreeNode>();
  for (const page of pages) {
    if (page.archivedAt) continue;
    byId.set(page.id, { page, children: [] });
  }

  const roots: Record<SectionId, TreeNode[]> = { workspace: [], private: [], shared: [] };
  for (const node of byId.values()) {
    const { parentId } = node.page;
    if (parentId === null) {
      if (node.page.visibility !== "private") roots.workspace.push(node);
      else if (options.userId && node.page.createdBy !== options.userId) roots.shared.push(node);
      else roots.private.push(node);
    } else {
      const parent = byId.get(parentId);
      if (parent) parent.children.push(node);
      else roots.shared.push(node);
    }
  }

  const byPosition = (a: TreeNode, b: TreeNode) => comparePages(a.page, b.page);
  for (const node of byId.values()) node.children.sort(byPosition);
  for (const section of Object.keys(roots) as SectionId[]) roots[section].sort(byPosition);

  const sectionById = new Map<string, SectionId>();
  const assign = (nodes: TreeNode[], section: SectionId) => {
    for (const node of nodes) {
      sectionById.set(node.page.id, section);
      assign(node.children, section);
    }
  };
  for (const section of Object.keys(roots) as SectionId[]) assign(roots[section], section);

  return { byId, sectionById, roots };
}

export interface FlatItem {
  id: string;
  page: PageSummary;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
  section: SectionId;
  /** 1-based position among siblings, for aria-posinset / aria-setsize */
  posInSet: number;
  setSize: number;
}

/** Depth-first list of the rows that are currently visible given the expanded set. */
export function flattenVisible(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  section: SectionId,
): FlatItem[] {
  const out: FlatItem[] = [];
  const walk = (list: readonly TreeNode[], depth: number) => {
    list.forEach((node, index) => {
      const isExpanded = node.children.length > 0 && expanded.has(node.page.id);
      out.push({
        id: node.page.id,
        page: node.page,
        depth,
        parentId: node.page.parentId,
        hasChildren: node.children.length > 0,
        expanded: isExpanded,
        section,
        posInSet: index + 1,
        setSize: list.length,
      });
      if (isExpanded) walk(node.children, depth + 1);
    });
  };
  walk(nodes, 0);
  return out;
}

/** Is `id` equal to, or somewhere below, `ancestorId`? */
export function isDescendant(tree: Pick<PageTree, "byId">, id: string, ancestorId: string): boolean {
  let current: string | null = id;
  for (let guard = 0; current !== null && guard < 10_000; guard++) {
    if (current === ancestorId) return true;
    current = tree.byId.get(current)?.page.parentId ?? null;
  }
  return false;
}

export function ancestorIds(tree: Pick<PageTree, "byId">, id: string): string[] {
  const out: string[] = [];
  let current = tree.byId.get(id)?.page.parentId ?? null;
  for (let guard = 0; current !== null && guard < 10_000; guard++) {
    if (!tree.byId.has(current)) break;
    out.unshift(current);
    current = tree.byId.get(current)?.page.parentId ?? null;
  }
  return out;
}

/** Ancestors root -> parent, as page summaries (used when the page detail isn't loaded yet). */
export function ancestorPages(tree: Pick<PageTree, "byId">, id: string): PageSummary[] {
  return ancestorIds(tree, id).map((a) => tree.byId.get(a)!.page);
}

export function descendantIds(tree: Pick<PageTree, "byId">, id: string): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode | undefined) => {
    for (const child of node?.children ?? []) {
      out.push(child.page.id);
      walk(child);
    }
  };
  walk(tree.byId.get(id));
  return out;
}

export function siblingsOf(tree: PageTree, parentId: string | null, section: SectionId): TreeNode[] {
  if (parentId === null) return tree.roots[section];
  return tree.byId.get(parentId)?.children ?? [];
}

export type DropPosition = "before" | "after" | "inside";

/** Body of `POST /pages/{id}/move`. */
export interface MoveTarget {
  parentId: string | null;
  afterId?: string;
  beforeId?: string;
}

/**
 * Translate a drop (active row dropped before/after/inside the row `overId`) into a move request.
 * Returns null when the drop is invalid (self, cycle, cross-section root move) or a no-op.
 */
export function resolveDrop(
  tree: PageTree,
  args: { activeId: string; overId: string; position: DropPosition },
): MoveTarget | null {
  const { activeId, overId, position } = args;
  if (activeId === overId) return null;
  const active = tree.byId.get(activeId);
  const over = tree.byId.get(overId);
  if (!active || !over) return null;

  // Moving a page under itself or one of its own descendants would create a cycle.
  if (isDescendant(tree, overId, activeId)) return null;

  const activeSection = tree.sectionById.get(activeId);
  const overSection = tree.sectionById.get(overId);
  if (!activeSection || !overSection) return null;
  // Pages shared individually have no visible parent context; they stay where they are.
  if (activeSection === "shared" || overSection === "shared") return null;

  let target: MoveTarget;
  if (position === "inside") target = { parentId: overId };
  else if (position === "before") target = { parentId: over.page.parentId, beforeId: overId };
  else target = { parentId: over.page.parentId, afterId: overId };

  // Top-level placement across Workspace <-> Private would silently change visibility; use the share dialog.
  if (target.parentId === null && activeSection !== overSection) return null;

  return isNoop(tree, active, target, overSection) ? null : target;
}

/** Drop on the "end of section" zone: make the page the last top-level page of its own section. */
export function resolveDropAtEnd(tree: PageTree, activeId: string, section: SectionId): MoveTarget | null {
  const active = tree.byId.get(activeId);
  if (!active || section === "shared") return null;
  if (tree.sectionById.get(activeId) !== section) return null;
  const roots = tree.roots[section];
  const last = roots[roots.length - 1];
  if (!last) return null;
  if (last.page.id === activeId) return null;
  return { parentId: null, afterId: last.page.id };
}

function isNoop(tree: PageTree, active: TreeNode, target: MoveTarget, destSection: SectionId): boolean {
  if (active.page.parentId !== target.parentId) return false;
  const siblings = siblingsOf(tree, target.parentId, destSection);
  const i = siblings.findIndex((s) => s.page.id === active.page.id);
  if (i < 0) return false;
  if (target.beforeId) return siblings[i + 1]?.page.id === target.beforeId;
  if (target.afterId) return siblings[i - 1]?.page.id === target.afterId;
  return i === siblings.length - 1; // append while already last
}

/** Keyboard reorder (Alt+Up / Alt+Down): swap with the neighbouring sibling. */
export function moveWithinSiblings(tree: PageTree, id: string, direction: -1 | 1): MoveTarget | null {
  const node = tree.byId.get(id);
  const section = tree.sectionById.get(id);
  if (!node || !section || section === "shared") return null;
  const siblings = siblingsOf(tree, node.page.parentId, section);
  const i = siblings.findIndex((s) => s.page.id === id);
  if (i < 0) return null;
  if (direction === -1) {
    const prev = siblings[i - 1];
    return prev ? { parentId: node.page.parentId, beforeId: prev.page.id } : null;
  }
  const next = siblings[i + 1];
  return next ? { parentId: node.page.parentId, afterId: next.page.id } : null;
}

/** Insert or replace by id, keeping other entries untouched. */
export function upsertPage(list: readonly PageSummary[], page: PageSummary): PageSummary[] {
  const i = list.findIndex((p) => p.id === page.id);
  if (i < 0) return [...list, page];
  const next = list.slice();
  next[i] = page;
  return next;
}
