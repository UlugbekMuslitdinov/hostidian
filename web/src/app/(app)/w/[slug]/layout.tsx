"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { TopBar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { useRoute } from "@/lib/nav";
import { useOptionalWorkspace } from "@/lib/workspace";
import { FileQuestion } from "lucide-react";

/** Renders "workspace not found" when the URL slug isn't one of the user's workspaces. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const route = useRoute();
  const slug = route.kind === "other" ? undefined : route.slug;
  const ws = useOptionalWorkspace();

  if (!ws || ws.workspace.slug !== slug) {
    return (
      <>
        <TopBar />
        <EmptyState
          icon={FileQuestion}
          title="Workspace not found"
          description="This workspace doesn't exist, or you're not a member of it."
          action={
            <Button asChild>
              <Link href="/">Go to my workspace</Link>
            </Button>
          }
        />
      </>
    );
  }
  return children;
}
