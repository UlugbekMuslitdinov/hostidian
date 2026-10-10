"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MutableRefObject,
} from "react";
import type { ForceGraphMethods, ForceGraphProps, GraphData, NodeObject } from "react-force-graph-2d";
import { isLinkMatched, linkIds, nodeRadius, type GraphLink, type GraphNode } from "./graph-model";

/**
 * The canvas-based force graph is loaded lazily and only rendered once the container has been measured
 * on the client. force-graph touches `window` and the canvas API at import time, so the module is never
 * imported during SSR/prerender.
 */
interface ForceGraphCanvasProps {
  nodes: GraphNode[];
  links: GraphLink[];
  matched: ReadonlySet<string>;
  onSelect: (id: string) => void;
  /** The page a local graph is centred on: drawn with a ring. */
  centerId?: string;
}

/** Few-node graphs must not be blown up to fill the canvas: nodes would become huge discs. */
const MAX_FIT_ZOOM = 1.6;
const FIT_PADDING = 70;
const FIT_ANIMATION_MS = 400;
/** d3 forces: the defaults pack small graphs into a dense blob where labels overlap. */
const LINK_DISTANCE = 80;
const CHARGE_STRENGTH = -260;
const CHARGE_MAX_DISTANCE = 260;

function configureForces(graph: ForceGraphMethods<GraphNode, GraphLink>) {
  const charge = graph.d3Force("charge") as
    | { strength?: (value: number) => unknown; distanceMax?: (value: number) => unknown }
    | undefined;
  charge?.strength?.(CHARGE_STRENGTH);
  // Beyond this distance nodes ignore each other, so unlinked pages are not flung to the edge of the world.
  charge?.distanceMax?.(CHARGE_MAX_DISTANCE);
  const link = graph.d3Force("link") as { distance?: (value: number) => unknown } | undefined;
  link?.distance?.(LINK_DISTANCE);
}

type ForceGraphComponent = ComponentType<
  ForceGraphProps<GraphNode, GraphLink> & {
    ref?: MutableRefObject<ForceGraphMethods<GraphNode, GraphLink> | undefined>;
  }
>;

const ForceGraph2D = lazy(() => import("react-force-graph-2d")) as unknown as ForceGraphComponent;

const FALLBACK_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";

interface GraphTheme {
  node: string;
  nodeMuted: string;
  link: string;
  linkMuted: string;
  label: string;
}

const FALLBACK_THEME: GraphTheme = {
  node: "#1f76d1",
  nodeMuted: "#9aa0a6",
  link: "rgba(120, 120, 120, 0.5)",
  linkMuted: "rgba(120, 120, 120, 0.15)",
  label: "#37352f",
};

/** Resolve a design token to a concrete rgb() string the canvas can paint. */
function resolveColor(variable: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || fallback;
}

function withAlpha(color: string, alpha: number): string {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (match?.[1]) {
    const [r, g, b] = match[1].split(",").map((value) => value.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function readTheme(): GraphTheme {
  if (typeof window === "undefined" || typeof document === "undefined") return FALLBACK_THEME;
  return {
    node: resolveColor("--primary", FALLBACK_THEME.node),
    nodeMuted: resolveColor("--muted-foreground", FALLBACK_THEME.nodeMuted),
    link: withAlpha(resolveColor("--muted-foreground", "#6b6a66"), 0.5),
    linkMuted: withAlpha(resolveColor("--muted-foreground", "#6b6a66"), 0.12),
    label: resolveColor("--foreground", FALLBACK_THEME.label),
  };
}

function useGraphTheme(): GraphTheme {
  const [theme, setTheme] = useState<GraphTheme>(() => readTheme());
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** Truncate a canvas label to fit `maxWidth` graph units, appending an ellipsis. */
function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

export function ForceGraphCanvas({ nodes, links, matched, onSelect, centerId }: ForceGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  /** The `data` object the camera was last fitted to, so a changed graph (local depth, new links) is fitted again. */
  const fittedRef = useRef<unknown>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const theme = useGraphTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Copy once per model so force-graph can mutate x/y without touching our memoized model, and so the
  // simulation keeps its positions while the text filter changes.
  const data = useMemo<GraphData<GraphNode, GraphLink>>(
    () => ({
      nodes: nodes.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    }),
    [nodes, links],
  );

  const drawNode = useCallback(
    (node: NodeObject<GraphNode>, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = nodeRadius(node.degree);
      const dim = !matched.has(node.id);
      const isHovered = hovered === node.id;
      const isIsolated = node.degree === 0;

      ctx.save();
      ctx.globalAlpha = dim ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(x, y, radius + (isHovered ? 1.5 : 0), 0, Math.PI * 2);
      ctx.fillStyle = isIsolated ? theme.nodeMuted : theme.node;
      ctx.fill();
      if (node.id === centerId) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.label;
        ctx.stroke();
      }

      // Labels keep a constant on-screen size; skip them when zoomed too far out to stay readable.
      if (isHovered || globalScale >= 0.45) {
        const fontSize = Math.max(11 / globalScale, 1.5);
        ctx.font = `${fontSize}px ${FALLBACK_FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = theme.label;
        const label = fitLabel(ctx, node.title, 140 / globalScale);
        ctx.fillText(label, x, y + radius + 2 / globalScale);
      }
      ctx.restore();
    },
    [hovered, matched, theme, centerId],
  );

  const paintPointer = useCallback((node: NodeObject<GraphNode>, color: string, ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node.degree) + 3, 0, Math.PI * 2);
    ctx.fill();
  }, []);

  const linkColor = useCallback(
    (link: GraphLink) => (isLinkMatched(linkIds(link), matched) ? theme.link : theme.linkMuted),
    [matched, theme],
  );

  const linkWidth = useCallback(
    (link: GraphLink) => (isLinkMatched(linkIds(link), matched) ? 1.2 : 0.6),
    [matched],
  );

  // A callback ref: the lazily loaded graph only exists some time after mount, and its forces have to be tuned
  // before it starts simulating.
  const setGraph = useCallback((instance: ForceGraphMethods<GraphNode, GraphLink> | null) => {
    graphRef.current = instance ?? undefined;
    if (instance) configureForces(instance);
  }, []) as unknown as MutableRefObject<ForceGraphMethods<GraphNode, GraphLink> | undefined>; // the component's ref prop is typed as an object ref

  /**
   * Node positions in container pixels, as a data attribute: the canvas has no DOM for its nodes, so this is the
   * machine-readable counterpart (used by end-to-end tests to click a node). `data-layout` is "ready" once the
   * layout has settled and the camera has been fitted. Updated then and after zooming/panning, not every frame.
   */
  const publishPositions = useCallback((settled = false) => {
    const element = containerRef.current;
    const graph = graphRef.current;
    if (!element || !graph) return;
    if (settled) element.dataset.layout = "ready";
    const positions: Record<string, [number, number]> = {};
    for (const node of data.nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      const point = graph.graph2ScreenCoords(node.x, node.y);
      positions[node.id] = [Math.round(point.x), Math.round(point.y)];
    }
    element.dataset.nodeScreen = JSON.stringify(positions);
  }, [data]);

  // A new graph restarts the simulation: until it has settled again, positions are not final.
  useEffect(() => {
    if (containerRef.current) containerRef.current.dataset.layout = "settling";
  }, [data]);

  const handleEngineStop = useCallback(() => {
    const graph = graphRef.current;
    if (!graph || fittedRef.current === data) return;
    fittedRef.current = data;
    window.setTimeout(() => publishPositions(true), FIT_ANIMATION_MS + 100);
    const box = graph.getGraphBbox();
    if (!box) return;
    const width = Math.max(1, box.x[1] - box.x[0]) + FIT_PADDING * 2;
    const height = Math.max(1, box.y[1] - box.y[0]) + FIT_PADDING * 2;
    const zoom = Math.min(MAX_FIT_ZOOM, size.width / width, size.height / height);
    graph.centerAt((box.x[0] + box.x[1]) / 2, (box.y[0] + box.y[1]) / 2, FIT_ANIMATION_MS);
    graph.zoom(zoom, FIT_ANIMATION_MS);
  }, [data, size.width, size.height, publishPositions]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      data-testid="graph-canvas"
      data-nodes={nodes.length}
      data-links={links.length}
    >
      {size.width > 0 && size.height > 0 ? (
        <Suspense fallback={null}>
          <ForceGraph2D
            ref={setGraph}
            width={size.width}
            height={size.height}
            graphData={data}
            nodeId="id"
            linkSource="source"
            linkTarget="target"
            backgroundColor="transparent"
            nodeRelSize={1}
            nodeVal={(node) => Math.max(1, nodeRadius(node.degree) ** 2)}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={paintPointer}
            nodeLabel={(node) => node.title}
            linkColor={linkColor}
            linkWidth={linkWidth}
            onNodeClick={(node) => onSelect(node.id)}
            onNodeHover={(node) => setHovered(node ? node.id : null)}
            onEngineStop={handleEngineStop}
            onZoomEnd={() => publishPositions()}
            warmupTicks={30}
            cooldownTicks={120}
            d3AlphaDecay={0.03}
            minZoom={0.15}
            maxZoom={8}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
