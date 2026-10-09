"use client";

import { useQuery } from "@tanstack/react-query";
import { Home, Network, PanelLeftClose, Search, Settings, Trash2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useAppUI } from "@/components/layout/app-ui";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { favoritesOptions, pagesOptions } from "@/lib/api/queries";
import { workspaceHref } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";
import { PageTree } from "./page-tree";
import { SidebarButton, SidebarLink } from "./sidebar-link";
import { WorkspaceSwitcher } from "./workspace-switcher";

const isMac = () =>
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** Sidebar content, shared by the desktop column and the mobile drawer. */
export function Sidebar({ inDrawer = false }: { inDrawer?: boolean }) {
  const { workspace } = useWorkspace();
  const pathname = usePathname();
  const ui = useAppUI();
  const pagesQuery = useQuery(pagesOptions(workspace.id));
  const favoritesQuery = useQuery(favoritesOptions(workspace.id));

  const home = workspaceHref(workspace.slug);
  const trash = `${home}/trash`;
  const graph = `${home}/graph`;
  const mod = isMac() ? "⌘" : "Ctrl+";

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar pt-safe pb-safe pl-safe text-sidebar-foreground">
      <div className={`flex items-center gap-1 px-2 pt-2 pb-1 ${inDrawer ? "pr-14" : ""}`}>
        <WorkspaceSwitcher />
        {!inDrawer && (
          <Tip label="Close sidebar" shortcut={`${mod}\\`}>
            <Button variant="ghost" size="icon-sm" onClick={ui.toggleSidebar} aria-label="Close sidebar">
              <PanelLeftClose />
            </Button>
          </Tip>
        )}
      </div>

      <nav aria-label="Primary" className="flex flex-col gap-px px-2 py-1">
        <SidebarButton icon={<Search />} hint={`${mod}K`} onClick={() => ui.setPaletteOpen(true)}>
          Search
        </SidebarButton>
        <SidebarLink href={home} icon={<Home />} active={pathname === home}>
          Home
        </SidebarLink>
        <SidebarLink href={graph} icon={<Network />} active={pathname === graph}>
          Graph
        </SidebarLink>
      </nav>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1 pt-2">
        {pagesQuery.data ? (
          <PageTree key={workspace.id} pages={pagesQuery.data} favorites={favoritesQuery.data ?? []} />
        ) : pagesQuery.isError ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            <p>Couldn&apos;t load your pages.</p>
            <Button variant="link" size="sm" className="px-0" onClick={() => void pagesQuery.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-2" aria-busy="true" aria-label="Loading pages">
            {[70, 55, 80, 45, 65].map((w, i) => (
              <Skeleton key={i} className="h-5" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="flex flex-col gap-px border-t border-sidebar-border px-2 py-2">
        <SidebarLink href={trash} icon={<Trash2 />} active={pathname === trash}>
          Trash
        </SidebarLink>
        <SidebarLink href="/settings" icon={<Settings />} active={pathname.startsWith("/settings")}>
          Settings
        </SidebarLink>
      </div>
    </div>
  );
}
