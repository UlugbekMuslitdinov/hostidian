import type { Metadata } from "next";
import { WorkspaceRoutes } from "@/components/layout/workspace-routes";

export const metadata: Metadata = { title: "Trash" };

export default function TrashPage() {
  return <WorkspaceRoutes />;
}
