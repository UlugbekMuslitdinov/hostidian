"use client";

import type { EffectiveRole } from "@hostidian/api-types";

// WAVE 2 (web-editor): replace this file wholesale with the BlockNote + Hocuspocus editor.
// Contract with the page route: `pageId` selects the document, `role` decides read-only vs editable.
// To show collaborators in the header call `usePublishPresence(users)` from "@/components/page/presence".
export function PageEditor({ pageId, role }: { pageId: string; role: EffectiveRole }) {
  return (
    <div
      data-page-editor=""
      className="my-6 rounded-lg border border-dashed bg-muted/50 px-4 py-10 text-center text-sm text-muted-foreground"
    >
      <p className="font-medium text-foreground">Editor coming in wave 2</p>
      <p className="mt-1">
        Page <code className="font-mono text-xs">{pageId}</code> ·{" "}
        {role === "view" || role === "comment" ? "read-only" : "editable"} ({role})
      </p>
    </div>
  );
}
