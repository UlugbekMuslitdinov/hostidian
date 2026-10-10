"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { graphOptions } from "@/lib/api/queries";
import { buildGraphModel, matchGraph, neighborhood, type GraphModel } from "./graph-model";

/**
 * Fetches the workspace graph and derives the (stable) force-graph model plus the active filter match. With a
 * `local` option the model is cut down to the pages within `depth` links of `centerId`.
 */
export function useGraph(
  workspaceId: string,
  filter: string,
  options: { enabled?: boolean; local?: { centerId: string; depth: number } | null } = {},
) {
  const query = useQuery({ ...graphOptions(workspaceId), enabled: options.enabled ?? true });
  const centerId = options.local?.centerId;
  const depth = options.local?.depth ?? 1;

  const full = useMemo(() => buildGraphModel(query.data ?? { nodes: [], edges: [] }), [query.data]);
  const model = useMemo<GraphModel>(
    () => (centerId ? neighborhood(full, centerId, depth) : full),
    [full, centerId, depth],
  );
  const match = useMemo(() => matchGraph(model, filter), [model, filter]);

  return { query, full, model, match };
}
