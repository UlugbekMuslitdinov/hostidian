import type { MetadataRoute } from "next";

// Colors mirror the light-mode design tokens in globals.css (--background). The dark counterpart is
// delivered through the per-scheme <meta name="theme-color"> tags in layout.tsx; a manifest only has one value.
const BACKGROUND = "#ffffff";
const THEME = "#ffffff";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Hostidian",
    short_name: "Hostidian",
    description: "Self-hosted, collaborative notes that keep working offline.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: BACKGROUND,
    theme_color: THEME,
    categories: ["productivity", "business", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      {
        name: "New page",
        short_name: "New page",
        description: "Create a page in your workspace",
        // Handled by <LaunchActions/> once the session and workspace are known.
        url: "/?action=new-page",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
