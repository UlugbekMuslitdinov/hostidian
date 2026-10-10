import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSerwistRoute } from "@serwist/turbopack";
import { PRECACHED_DOCUMENTS } from "@/lib/offline/sw-routes";

// Turbopack has no plugin API for emitting a service worker, so @serwist/turbopack builds src/app/sw.ts with esbuild
// from this route handler (prerendered at `next build`, served from /serwist/sw.js). The page registers it with
// scope "/" (allowed through the Service-Worker-Allowed header, see next.config.ts).

/** Version of the app-shell documents: they change whenever the build does (their chunk URLs are hashed). */
function documentRevision(): string {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return `dev-${Date.now()}`; // `next dev`: no BUILD_ID, and nothing is precached there anyway
  }
}

const revision = documentRevision();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  swSrc: "src/app/sw.ts",
  useNativeEsbuild: true,
  // Hashed build assets (incl. fonts, which the default patterns omit) and everything in public/.
  globPatterns: [
    ".next/static/**/*.{js,css,woff2,woff,ico,png,svg,webp,avif,json}",
    "public/**/*",
  ],
  globIgnores: ["**/*.map", "public/icons/*.svg", "public/emoji/LICENSE.txt"],
  // The editor chunks are large; the default 2 MiB limit would silently drop them from the precache.
  maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
  additionalPrecacheEntries: PRECACHED_DOCUMENTS.map((url) => ({ url, revision })),
  // Classic worker script (registered without `type: "module"`), supported by every browser with service workers.
  esbuildOptions: { format: "iife" },
});
