import type { Graph } from "@hostidian/api-types";
import { pageTitle } from "@/lib/utils";

/**
 * Pure, framework-free view model for the workspace graph. Kept separate from React so the
 * degree/filter logic is unit-testable without a canvas.
 */

export type GraphNode = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  /** Number of visible links touching this node (in + out). */
  degree: number;
};

export type GraphLink = {
  source: string;
  target: string;
};

export type GraphModel = {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Nodes with no visible links; rendered muted and tiny. */
  isolatedCount: number;
};

/** The set of nodes that match the current text filter. */
export type GraphMatch = {
  matched: ReadonlySet<string>;
  count: number;
  total: number;
};

export const MIN_NODE_RADIUS = 4;
export const MAX_NODE_RADIUS = 11;

/** Degree-based sizing: more connections → bigger node, capped so hubs don't dominate. */
export function nodeRadius(degree: number): number {
  const d = Math.max(0, degree);
  return Math.min(MAX_NODE_RADIUS, MIN_NODE_RADIUS + Math.sqrt(d) * 2.2);
}

/** Turn the API payload into nodes (with degree) and de-duplicated, valid links. */
export function buildGraphModel(graph: Graph): GraphModel {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const seen = new Set<string>();
  const links: GraphLink[] = [];

  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    const key = `${edge.source}\u0000${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: edge.source, target: edge.target });
  }

  const degree = new Map<string, number>();
  for (const node of graph.nodes) degree.set(node.id, 0);
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = graph.nodes.map((node) => ({
    id: node.id,
    title: pageTitle(node.title),
    icon: node.icon ?? null,
    parentId: node.parentId ?? null,
    degree: degree.get(node.id) ?? 0,
  }));

  return { nodes, links, isolatedCount: nodes.filter((node) => node.degree === 0).length };
}

/** Case-insensitive title filter. An empty query matches everything. */
export function matchGraph(model: GraphModel, query: string): GraphMatch {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { matched: new Set(model.nodes.map((node) => node.id)), count: model.nodes.length, total: model.nodes.length };
  }
  const matched = new Set<string>();
  for (const node of model.nodes) {
    if (node.title.toLowerCase().includes(needle)) matched.add(node.id);
  }
  return { matched, count: matched.size, total: model.nodes.length };
}

/** A link is highlighted only when both endpoints match the filter. */
export function isLinkMatched(link: GraphLink, matched: ReadonlySet<string>): boolean {
  return matched.has(link.source) && matched.has(link.target);
}

export const LOCAL_GRAPH_MAX_DEPTH = 3;

/**
 * The local graph around one page: the page itself plus every page within `depth` links of it, following links in
 * either direction (a page that links here matters as much as one linked from here), with the links among them.
 * Degrees are recomputed for the subset so node sizes reflect what is on screen. An unknown centre gives an empty
 * model.
 */
export function neighborhood(model: GraphModel, centerId: string, depth: number): GraphModel {
  const known = new Set(model.nodes.map((node) => node.id));
  if (!known.has(centerId)) return { nodes: [], links: [], isolatedCount: 0 };

  const adjacency = new Map<string, string[]>();
  for (const link of model.links) {
    (adjacency.get(link.source) ?? adjacency.set(link.source, []).get(link.source)!).push(link.target);
    (adjacency.get(link.target) ?? adjacency.set(link.target, []).get(link.target)!).push(link.source);
  }

  const maxDepth = Math.max(0, Math.min(LOCAL_GRAPH_MAX_DEPTH, Math.floor(depth)));
  const keep = new Set([centerId]);
  let frontier = [centerId];
  for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacency.get(id) ?? []) {
        if (keep.has(other)) continue;
        keep.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }

  const links = model.links.filter((link) => keep.has(link.source) && keep.has(link.target));
  const degree = new Map<string, number>();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  const nodes = model.nodes
    .filter((node) => keep.has(node.id))
    .map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
  return { nodes, links, isolatedCount: nodes.filter((node) => node.degree === 0).length };
}

/**
 * force-graph swaps each link's `source`/`target` ids for the node objects once it has wired them up, so the
 * accessors it calls back (linkColor, linkWidth) see objects even though our links are typed with ids.
 */
export function linkIds(link: GraphLink): GraphLink {
  const end = (value: unknown): string =>
    typeof value === "object" && value !== null ? String((value as { id?: unknown }).id) : String(value);
  return { source: end(link.source), target: end(link.target) };
}
