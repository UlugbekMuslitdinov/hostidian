"use client";

import { PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppUI } from "./app-ui";

/** Button that opens the drawer (mobile) or re-opens the collapsed sidebar (desktop). */
export function SidebarToggle({ className }: { className?: string }) {
  const ui = useAppUI();
  return (
    <Tip label="Open sidebar" shortcut="⌘\">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Open sidebar"
        onClick={ui.toggleSidebar}
        className={cn(ui.sidebarOpen && "md:hidden", className)}
      >
        <PanelLeft />
      </Button>
    </Tip>
  );
}

/** Sticky page top bar. Pages put breadcrumbs / actions inside. */
export function TopBar({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        "sticky top-0 z-20 flex min-h-12 items-center gap-1 border-b border-transparent bg-background/90 px-2 pt-safe pr-safe backdrop-blur supports-[backdrop-filter]:bg-background/75 md:px-3",
        className,
      )}
    >
      <SidebarToggle />
      {children}
    </header>
  );
}
