"use client";

import { SerwistProvider, useSerwist } from "@serwist/turbopack/react";
import { useTheme } from "next-themes";
import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { startInstallTracking } from "@/lib/offline/install";
import { UPDATE_CHECK_INTERVAL_MS, watchForUpdates } from "@/lib/offline/sw-update";

/** Served by app/serwist/[path]/route.ts; `Service-Worker-Allowed: /` (next.config.ts) lets it control the whole origin. */
export const SERVICE_WORKER_URL = "/serwist/sw.js";

// The worker only exists in production builds: in `next dev` it would cache stale chunks and fight HMR.
const SERVICE_WORKER_ENABLED = process.env.NODE_ENV === "production";

/**
 * Registers the service worker, runs the update flow, keeps the browser chrome color in sync with the theme and
 * starts tracking the install prompt. Renders no UI of its own.
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    startInstallTracking();
  }, []);

  return (
    <SerwistProvider
      swUrl={SERVICE_WORKER_URL}
      disable={!SERVICE_WORKER_ENABLED}
      // The classic-script build (app/serwist/[path]/route.ts uses esbuild format "iife").
      options={{ scope: "/", type: "classic", updateViaCache: "none" }}
      // Navigation is client-side (lib/nav.tsx) and the worker serves one shell for every workspace URL, so
      // there is nothing to warm per visited URL; and reloading the page whenever the network returns would
      // interrupt whatever the user is doing offline-first.
      cacheOnNavigation={false}
      reloadOnOnline={false}
    >
      <ServiceWorkerLifecycle />
      <ThemeColorSync />
      {children}
    </SerwistProvider>
  );
}

function ServiceWorkerLifecycle() {
  const { serwist } = useSerwist();

  useEffect(() => {
    if (SERVICE_WORKER_ENABLED || !("serviceWorker" in navigator)) return;
    // A worker left behind by a production build on this origin (same port) would serve stale chunks to `next dev`.
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!serwist) return;
    const stopWatching = watchForUpdates(serwist, {
      prompt(accept) {
        toast("New version available", {
          id: "sw-update",
          description: "Reload to get the latest Hostidian.",
          duration: Infinity,
          action: { label: "Reload", onClick: accept },
        });
      },
      reload: () => window.location.reload(),
    });

    // Browsers only look for a new worker on navigation; an installed app can stay open for days.
    const check = () => void serwist.update().catch(() => undefined);
    const timer = window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopWatching();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [serwist]);

  return null;
}

/** Same values as the `viewport.themeColor` entries in app/layout.tsx (the `--background` tokens). */
export const THEME_COLORS = { light: "#ffffff", dark: "#191919" } as const;

/**
 * `<meta name="theme-color">` in layout.tsx follows the OS color scheme only. When the user picks a theme in the
 * app that differs from the OS, the status bar / title bar of the installed app should follow the app.
 */
function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-app-theme]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.setAttribute("data-app-theme", "");
      // First in tree order wins when several theme-color tags match.
      document.head.prepend(meta);
    }
    meta.content = THEME_COLORS[resolvedTheme];
  }, [resolvedTheme]);
  return null;
}
