/// <reference lib="webworker" />
/**
 * Hostidian service worker (bundled by app/serwist/[path]/route.ts with esbuild, served at /serwist/sw.js
 * with `Service-Worker-Allowed: /`).
 *
 * - Precaches the build assets, public/ files (icons, emoji data, offline page) and the app-shell documents.
 * - Navigations: network-first (short timeout), then a cached copy, then the precached shell for workspace
 *   routes. RSC payloads follow the same rule so client-side navigation never breaks offline.
 * - Attachments: cache-first with expiry. Everything else under /api and /collab is left to the network.
 * - Updates wait for the user: the page posts SKIP_WAITING after the "New version available" toast is accepted.
 *
 * The decisions themselves live in lib/offline/sw-routes.ts (unit-tested).
 */
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  RangeRequestsPlugin,
  Serwist,
  type PrecacheEntry,
  type RouteHandlerCallbackOptions,
  type SerwistGlobalConfig,
  type SerwistPlugin,
} from "serwist";
import {
  CACHE_NAMES,
  NAVIGATION_NETWORK_TIMEOUT_S,
  classifyRequest,
  isCacheableDocumentResponse,
  isCacheableFileResponse,
  isServerFailure,
  navigationFallbackUrl,
  type RouteKind,
} from "../lib/offline/sw-routes";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const kindOf = ({ request, url, sameOrigin }: { request: Request; url: URL; sameOrigin: boolean }): RouteKind =>
  classifyRequest({
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    sameOrigin,
    mode: request.mode,
    rscHeader: request.headers.get("RSC"),
  });

/** Only store what the policy in sw-routes allows. */
const admit = (allow: (response: Response) => boolean): SerwistPlugin => ({
  cacheWillUpdate: async ({ response }) => (allow(response) ? response : null),
});

/** Treat 5xx from the origin/proxy as "network unavailable" so the cached copy or app shell takes over. */
const failOnServerError: SerwistPlugin = {
  fetchDidSucceed: async ({ response }) => {
    if (isServerFailure(response.status)) throw new Error(`upstream ${response.status}`);
    return response;
  },
};

const pagesStrategy = new NetworkFirst({
  cacheName: CACHE_NAMES.pages,
  networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_S,
  plugins: [
    failOnServerError,
    admit(isCacheableDocumentResponse),
    new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 7 * 24 * 60 * 60, purgeOnQuotaError: true }),
  ],
});

const rscStrategy = new NetworkFirst({
  cacheName: CACHE_NAMES.rsc,
  networkTimeoutSeconds: NAVIGATION_NETWORK_TIMEOUT_S,
  matchOptions: { ignoreVary: true },
  plugins: [
    failOnServerError,
    admit(isCacheableDocumentResponse),
    new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 24 * 60 * 60, purgeOnQuotaError: true }),
  ],
});

const nextStaticStrategy = new CacheFirst({
  cacheName: CACHE_NAMES.nextStatic,
  plugins: [
    admit((r) => r.status === 200),
    new ExpirationPlugin({ maxEntries: 128, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true }),
  ],
});

const filesStrategy = new CacheFirst({
  cacheName: CACHE_NAMES.files,
  matchOptions: { ignoreVary: true },
  plugins: [
    admit((r) => isCacheableFileResponse(r)),
    // Serves Range requests (audio/video seeking) from a cached full response.
    new RangeRequestsPlugin(),
    new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60, purgeOnQuotaError: true }),
  ],
});

const serwist: Serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: { cleanupOutdatedCaches: true, concurrency: 6 },
  // An update installs in the background and waits; the page posts SKIP_WAITING once the user accepts the toast.
  skipWaiting: false,
  // The very first install has nothing to wait for and should control the open tab immediately (so it works
  // offline without a second visit); later versions only activate after SKIP_WAITING.
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    { matcher: (ctx) => kindOf(ctx) === "file", handler: filesStrategy },
    {
      matcher: (ctx) => kindOf(ctx) === "next-static",
      handler: nextStaticStrategy,
    },
    {
      matcher: (ctx) => kindOf(ctx) === "rsc",
      // A thrown error makes Next.js fall back to a regular (hard) navigation, which the rule below answers.
      handler: (ctx: RouteHandlerCallbackOptions) => rscStrategy.handle(ctx),
    },
    {
      matcher: (ctx) => kindOf(ctx) === "navigation",
      handler: async (ctx: RouteHandlerCallbackOptions): Promise<Response> => {
        try {
          return await pagesStrategy.handle(ctx);
        } catch (error) {
          const fallback: Response | undefined = await serwist.matchPrecache(navigationFallbackUrl(ctx.url.pathname));
          if (fallback) return fallback;
          throw error;
        }
      },
    },
    // "network-only" and "ignore" requests (all of /api except files, /collab, non-GET, cross-origin) match nothing
    // here, so they reach the network exactly as if there were no service worker.
  ],
});

serwist.addEventListeners();
