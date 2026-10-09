"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { graphOptions } from "@/lib/api/queries";
import { buildGraphModel, matchGraph, type GraphMatch, type GraphModel } from "./graph-model";

export interface UseGraphResult {
  model: GraphModel;
  match: GraphMatch;
}

/** Fetches the workspace graph and derives the (stable) force-graph model plus the active filter match. */
export function useGraph(workspaceId: string, filter: string) {
  const query = useQuery(graphOptions(workspaceId));

  const model = useMemo(
    () => buildGraphModel(query.data ?? { nodes: [], edges: [] }),
    [query.data],
  );
  const match = useMemo(() => matchGraph(model, filter), [model, filter]);

  return { query, model, match };
}
