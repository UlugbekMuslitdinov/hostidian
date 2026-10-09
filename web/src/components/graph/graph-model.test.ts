import { describe, expect, it } from "vitest";
import type { Graph } from "@hostidian/api-types";
import { buildGraphModel, isLinkMatched, matchGraph, nodeRadius } from "./graph-model";

function graph(partial: Partial<Graph>): Graph {
  return { nodes: [], edges: [], ...partial };
}

describe("buildGraphModel", () => {
  it("counts degree from both endpoints and marks isolated nodes", () => {
    const model = buildGraphModel(
      graph({
        nodes: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
          { id: "c", title: "C" },
        ],
        edges: [
          { source: "a", target: "b" },
          { source: "a", target: "c" },
        ],
      }),
    );
    expect(model.nodes.map((n) => n.degree)).toEqual([2, 1, 1]);
    expect(model.links).toHaveLength(2);
    expect(model.isolatedCount).toBe(0);
  });

  it("falls back to 'Untitled' and normalises nullable fields", () => {
    const model = buildGraphModel(graph({ nodes: [{ id: "a", title: "  " }] }));
    expect(model.nodes[0]).toMatchObject({ title: "Untitled", icon: null, parentId: null, degree: 0 });
    expect(model.isolatedCount).toBe(1);
  });

  it("drops edges that are self-referential, unknown, or duplicated", () => {
    const model = buildGraphModel(
      graph({
        nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
        edges: [
          { source: "a", target: "a" },
          { source: "a", target: "ghost" },
          { source: "a", target: "b" },
          { source: "a", target: "b" },
        ],
      }),
    );
    expect(model.links).toEqual([{ source: "a", target: "b" }]);
    expect(model.nodes.map((n) => n.degree)).toEqual([1, 1]);
  });
});

describe("nodeRadius", () => {
  it("grows with degree and is capped", () => {
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(2));
    expect(nodeRadius(2)).toBeLessThan(nodeRadius(8));
    expect(nodeRadius(1000)).toBe(11);
    expect(nodeRadius(-3)).toBe(nodeRadius(0));
  });
});

describe("matchGraph", () => {
  const model = buildGraphModel(
    graph({
      nodes: [
        { id: "a", title: "Meeting notes" },
        { id: "b", title: null as unknown as string },
        { id: "c", title: "Roadmap" },
      ],
      edges: [{ source: "a", target: "c" }],
    }),
  );

  it("matches everything for an empty or whitespace query", () => {
    expect(matchGraph(model, "").count).toBe(3);
    expect(matchGraph(model, "   ").count).toBe(3);
  });

  it("matches titles case-insensitively and ignores surrounding whitespace", () => {
    const result = matchGraph(model, "  ROAD ");
    expect([...result.matched]).toEqual(["c"]);
    expect(result.count).toBe(1);
    expect(result.total).toBe(3);
  });

  it("matches the Untitled fallback", () => {
    expect([...matchGraph(model, "untitled").matched]).toEqual(["b"]);
  });

  it("marks a link matched only when both endpoints match", () => {
    const match = matchGraph(model, "a");
    expect(isLinkMatched(model.links[0]!, match.matched)).toBe(false);
    const all = matchGraph(model, "");
    expect(isLinkMatched(model.links[0]!, all.matched)).toBe(true);
  });
});
