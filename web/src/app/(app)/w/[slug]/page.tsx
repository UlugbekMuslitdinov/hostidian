import type { Metadata } from "next";
import { WorkspaceRoutes } from "@/components/layout/workspace-routes";

export const metadata: Metadata = { title: "Home" };

// Home, page and trash all render <WorkspaceRoutes/> (shallow client routing, see lib/nav.tsx).
export default function WorkspaceHomePage() {
  return <WorkspaceRoutes />;
}
