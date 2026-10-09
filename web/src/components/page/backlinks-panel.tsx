"use client";

import { queryOptions, useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { hasStatus } from "@/lib/api/error";
import { qk } from "@/lib/api/keys";
import { unwrap } from "@/lib/api/unwrap";
import { AppLink } from "@/lib/nav";
import { pageHref, pageTitle } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

const backlinksOptions = (pageId: string) =>
  queryOptions({
    queryKey: qk.backlinks(pageId),
    queryFn: ({ signal }) => unwrap(api.GET("/pages/{pageId}/backlinks", { params: { path: { pageId } }, signal })),
    retry: (count, error) => (hasStatus(error, 403, 404, 501) ? false : count < 2),
    staleTime: 30_000,
  });

/**
 * "Linked from" list under the page body: visible pages whose content links here. Empty (renders nothing)
 * for new pages or a server without the content feature.
 */
export function BacklinksPanel({ pageId }: { pageId: string }) {
  const { workspace } = useWorkspace();
  const query = useQuery(backlinksOptions(pageId));
  const backlinks = query.data ?? [];

  if (backlinks.length === 0) return null;

  return (
    <section className="mt-10 border-t pt-4" aria-label="Linked from">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden="true" />
        {backlinks.length} page{backlinks.length === 1 ? "" : "s"} link{backlinks.length === 1 ? "s" : ""} here
      </h2>
      <ul className="grid gap-0.5">
        {backlinks.map((page) => (
          <li key={page.id}>
            <AppLink
              href={pageHref(workspace.slug, page.id)}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <span className="size-4 text-center leading-none" aria-hidden="true">
                {page.icon ?? "•"}
              </span>
              <span className="truncate">{pageTitle(page.title)}</span>
            </AppLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
