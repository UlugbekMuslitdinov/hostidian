"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FullPageSpinner } from "@/components/common/spinner";
import { NoWorkspace } from "@/components/layout/no-workspace";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { workspaceHref } from "@/lib/utils";
import { useOptionalWorkspace } from "@/lib/workspace";

/** `/` -> last-used (or first) workspace. */
export default function RootPage() {
  const router = useRouter();
  const ws = useOptionalWorkspace();
  const slug = ws?.workspace.slug;
  useDocumentTitle(ws ? null : "Welcome");

  useEffect(() => {
    if (slug) router.replace(workspaceHref(slug));
  }, [slug, router]);

  if (!ws) return <NoWorkspace />;
  return <FullPageSpinner />;
}
