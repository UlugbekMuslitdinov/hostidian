"use client";

import { ChevronRight } from "lucide-react";
import { PageIcon } from "@/components/common/page-icon";
import type { PageRef } from "@hostidian/api-types";
import { AppLink } from "@/lib/nav";
import { cn, pageHref, pageTitle } from "@/lib/utils";

export function Breadcrumbs({
  workspaceSlug,
  ancestors,
  current,
}: {
  workspaceSlug: string;
  ancestors: readonly PageRef[];
  current: { title: string; icon?: string | null };
}) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center text-[13px] text-muted-foreground">
        {ancestors.map((a, i) => (
          <li
            key={a.id}
            // On phones only the immediate parent stays visible.
            className={cn("flex min-w-0 shrink items-center", i < ancestors.length - 1 && "hidden md:flex")}
          >
            <AppLink
              href={pageHref(workspaceSlug, a.id)}
              className="flex min-h-11 max-w-[11rem] items-center gap-1 truncate rounded-md px-1.5 hover:bg-accent hover:text-foreground md:min-h-7"
            >
              <PageIcon icon={a.icon} emojiClassName="text-sm" className="size-3.5" />
              <span className="truncate">{pageTitle(a.title)}</span>
            </AppLink>
            <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </li>
        ))}
        <li aria-current="page" className="flex min-w-0 items-center gap-1 px-1.5 font-medium text-foreground">
          <PageIcon icon={current.icon} emojiClassName="text-sm" className="size-3.5" />
          <span className="truncate">{pageTitle(current.title)}</span>
        </li>
      </ol>
    </nav>
  );
}
