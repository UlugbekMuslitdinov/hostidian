"use client";

import Link from "next/link";
import { PageIcon } from "@/components/common/page-icon";
import { cn } from "@/lib/utils";
import { flattenPublicTree, publicPagePath, type PublicPageMeta } from "./public-share";

/** Navigation for the shared subtree. Only rendered when `includeSubpages` is on. */
export function PublicPageTree({
  tree,
  token,
  currentPageId,
}: {
  tree: readonly PublicPageMeta[];
  token: string;
  currentPageId: string;
}) {
  const items = flattenPublicTree(tree, currentPageId);
  if (items.length === 0) return null;

  return (
    <nav aria-label="Pages in this share">
      <p className="mb-2 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Pages</p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={publicPagePath(token, item.id)}
              aria-current={item.current ? "page" : undefined}
              className={cn(
                "flex min-h-8 items-center gap-2 rounded-md py-1 pr-2 text-sm transition-colors",
                item.current
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
              style={{ paddingLeft: `${8 + item.depth * 12}px` }}
            >
              <PageIcon icon={item.icon} className="size-4" emojiClassName="text-base" />
              <span className="truncate">{item.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
