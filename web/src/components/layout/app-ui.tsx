"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { readStorage, STORAGE_KEYS, writeStorage } from "@/lib/storage";

interface AppUIValue {
  /** Desktop sidebar visibility (persisted). */
  sidebarOpen: boolean;
  /** Mobile slide-over; closes automatically when the route changes. */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  /** ⌘\ — toggles the desktop sidebar, or the drawer below `md`. */
  toggleSidebar: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** Page currently being moved via the "Move to…" picker. */
  movePageId: string | null;
  openMovePage: (pageId: string) => void;
  closeMovePage: () => void;
}

const AppUIContext = createContext<AppUIValue | null>(null);

const DESKTOP_QUERY = "(min-width: 768px)";

export function AppUIProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpenState] = useState(() => readStorage(STORAGE_KEYS.sidebarOpen) !== "0");
  // The drawer is "open for a specific path"; navigating elsewhere closes it without an effect.
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [movePageId, setMovePageId] = useState<string | null>(null);

  const drawerOpen = drawerPath !== null && drawerPath === pathname;
  const setDrawerOpen = useCallback((open: boolean) => setDrawerPath(open ? pathname : null), [pathname]);

  const toggleSidebar = useCallback(() => {
    const desktop = typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches;
    if (!desktop) {
      setDrawerPath((current) => (current === pathname ? null : pathname));
      return;
    }
    setSidebarOpenState((open) => {
      writeStorage(STORAGE_KEYS.sidebarOpen, open ? "0" : "1");
      return !open;
    });
  }, [pathname]);

  const value = useMemo<AppUIValue>(
    () => ({
      sidebarOpen,
      drawerOpen,
      setDrawerOpen,
      toggleSidebar,
      paletteOpen,
      setPaletteOpen,
      movePageId,
      openMovePage: setMovePageId,
      closeMovePage: () => setMovePageId(null),
    }),
    [sidebarOpen, drawerOpen, setDrawerOpen, toggleSidebar, paletteOpen, movePageId],
  );

  return <AppUIContext.Provider value={value}>{children}</AppUIContext.Provider>;
}

export function useAppUI(): AppUIValue {
  const ctx = useContext(AppUIContext);
  if (!ctx) throw new Error("useAppUI must be used inside <AppUIProvider>");
  return ctx;
}
