import type { Metadata } from "next";
import { WorkspaceRoutes } from "@/components/layout/workspace-routes";

export const metadata: Metadata = { title: "Graph" };

export default function GraphPage() {
  return <WorkspaceRoutes />;
}
