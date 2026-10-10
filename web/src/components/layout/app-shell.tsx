"use client";

import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { CommandPalette } from "@/components/palette/command-palette";
import { MovePageDialog } from "@/components/page/move-page-dialog";
import { LaunchActions } from "@/components/pwa/launch-actions";
import { OfflineBanner, useBannerState } from "@/components/pwa/offline-banner";
import { OfflineSync } from "@/components/pwa/offline-sync";
import { Sidebar } from "@/components/sidebar/sidebar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useWorkspaceEvents } from "@/lib/events/use-workspace-events";
import { useRoute } from "@/lib/nav";
import { useSession } from "@/lib/session";
import { readStorage, STORAGE_KEYS, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { resolveWorkspace, WorkspaceProvider, type WorkspaceValue } from "@/lib/workspace";
import { AppUIProvider, useAppUI } from "./app-ui";
import { GlobalShortcuts } from "./shortcuts";

/**
 * The authenticated frame: workspace context, sidebar (column on desktop, drawer on mobile),
 * live-update subscription, command palette and global shortcuts.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { workspaces } = useSession();
  const route = useRoute();
  const slug = route.kind === "other" ? undefined : route.slug;

  const membership = resolveWorkspace(workspaces, slug, readStorage(STORAGE_KEYS.lastWorkspace));
  const value = useMemo<WorkspaceValue | null>(
    () => (membership ? { workspace: membership.workspace, role: membership.role, memberships: workspaces } : null),
    [membership, workspaces],
  );

  const currentSlug = value?.workspace.slug;
  useEffect(() => {
    if (slug && currentSlug === slug) writeStorage(STORAGE_KEYS.lastWorkspace, slug);
  }, [slug, currentSlug]);

  return (
    <WorkspaceProvider value={value}>
      <AppUIProvider>
        <ShellFrame hasWorkspace={value !== null}>{children}</ShellFrame>
        <GlobalShortcuts />
        {value ? (
          <>
            <LiveUpdates workspaceId={value.workspace.id} />
            <OfflineSync />
            <LaunchActions />
            <CommandPalette />
            <MovePageDialog />
          </>
        ) : null}
      </AppUIProvider>
    </WorkspaceProvider>
  );
}

function LiveUpdates({ workspaceId }: { workspaceId: string }) {
  useWorkspaceEvents(workspaceId);
  return null;
}

function ShellFrame({ hasWorkspace, children }: { hasWorkspace: boolean; children: ReactNode }) {
  const ui = useAppUI();
  const isDesktop = useIsDesktop();
  const banner = useBannerState();
  // Phones always show the banner; on desktop the sidebar's connection indicator covers it unless it is collapsed.
  const bannerVisible = banner !== null && (!isDesktop || !ui.sidebarOpen);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <a
        href="#main"
        className="sr-only z-[70] rounded-md bg-background px-3 py-2 text-sm font-medium shadow-popover focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      {hasWorkspace && isDesktop && (
        <aside
          aria-label="Sidebar"
          inert={!ui.sidebarOpen}
          className={cn(
            "shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out",
            ui.sidebarOpen && "border-r border-sidebar-border",
          )}
          style={{ width: ui.sidebarOpen ? "var(--sidebar-width)" : 0 }}
        >
          <div className="h-full" style={{ width: "var(--sidebar-width)" }}>
            <Sidebar />
          </div>
        </aside>
      )}

      {hasWorkspace && !isDesktop && (
        <Sheet open={ui.drawerOpen} onOpenChange={ui.setDrawerOpen}>
          <SheetContent side="left" className="w-[min(88vw,340px)] border-r p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Workspace pages and navigation</SheetDescription>
            <Sidebar inDrawer />
          </SheetContent>
        </Sheet>
      )}

      <div
        className="flex min-w-0 flex-1 flex-col"
        // The banner takes the notch inset; page headers below it must not add it again (`.pt-safe`).
        style={bannerVisible ? ({ "--safe-top": "0px" } as CSSProperties) : undefined}
      >
        {bannerVisible && banner ? <OfflineBanner banner={banner} /> : null}
        <main
          id="main"
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
