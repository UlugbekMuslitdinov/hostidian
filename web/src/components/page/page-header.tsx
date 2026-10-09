"use client";

import { MoreHorizontal, Share2, Star } from "lucide-react";
import { useState } from "react";
import { TopBar } from "@/components/layout/topbar";
import { ShareDialog } from "@/components/share/share-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import type { PageActions } from "@/hooks/use-page-actions";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import type { PageDetail } from "@hostidian/api-types";
import { Breadcrumbs } from "./breadcrumbs";
import { PageMenuItems } from "./page-menu";
import { PresenceStack, usePresence } from "./presence";

export function PageHeader({ detail, actions }: { detail: PageDetail; actions: PageActions }) {
  const { workspace } = useWorkspace();
  const presence = usePresence();
  const [shareOpen, setShareOpen] = useState(false);
  const { page, isFavorite } = detail;

  return (
    <>
      <TopBar>
        <Breadcrumbs
          workspaceSlug={workspace.slug}
          ancestors={detail.breadcrumbs}
          current={{ title: page.title, icon: page.icon }}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <PresenceStack users={presence} />
          <Button variant="ghost" size="sm" className="ml-1 max-md:hidden" onClick={() => setShareOpen(true)}>
            Share
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="Share"
            onClick={() => setShareOpen(true)}
          >
            <Share2 />
          </Button>
          <Tip label={isFavorite ? "Remove from favorites" : "Add to favorites"}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-pressed={isFavorite}
              aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              onClick={() => actions.setFavorite(page.id, !isFavorite)}
            >
              <Star className={cn(isFavorite && "fill-amber-400 text-amber-400")} />
            </Button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Page actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <PageMenuItems page={page} isFavorite={isFavorite} actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TopBar>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} page={page} />
    </>
  );
}
