/**
 * Pure routing decisions for the service worker (src/app/sw.ts). Kept free of `self`/Serwist imports so the
 * rules that decide what may be cached are unit-testable.
 *
 * The data policy in one place:
 *  - `/api/files/*` and `/api/public/<token>/files/*` (images etc.): cache-first with expiry, only successful
 *    full responses of safe media types;
 *  - everything else under `/api/*` (incl. `/api/auth/*` and the SSE streams) and `/collab`: never touched;
 *    offline data comes from the persisted TanStack Query cache and y-indexeddb, not from HTTP caches;
 *  - non-GET and cross-origin requests: never touched (the app makes no third-party requests).
 */

/** Cache names holding per-user data. Anything with this prefix is wiped on logout / user change. */
export const USER_DATA_CACHE_PREFIX = "hostidian-user-";

export const CACHE_NAMES = {
  /** Attachments / images (user data). */
  files: `${USER_DATA_CACHE_PREFIX}files-v1`,
  /** HTML documents of visited routes (no user data: the pages are static client shells). */
  pages: "hostidian-pages-v1",
  /** Next.js RSC payloads for client-side navigations (no user data, same reason). */
  rsc: "hostidian-rsc-v1",
  /** Hashed build assets that were not part of the precache manifest (e.g. chunks of a newer deployment). */
  nextStatic: "hostidian-next-static-v1",
} as const;

/** Largest attachment the worker stores for offline use; bigger ones stay network-only. */
export const MAX_CACHED_FILE_BYTES = 25 * 1024 * 1024;

/** How long a navigation waits for the network before the cached copy is used. */
export const NAVIGATION_NETWORK_TIMEOUT_S = 3;

// ----------------------------------------------------------------------------------------------------------
// App shell documents
// ----------------------------------------------------------------------------------------------------------

/**
 * All `/w/<slug>[/p/<id> | /trash | /graph]` routes render the same client app (see lib/nav.tsx). They are
 * server-rendered on demand (dynamic segments), so the worker precaches one representative document per route
 * shape under placeholder segments and serves it for *any* workspace URL when the network is unavailable.
 * One document per shape (instead of a single one) keeps the router tree embedded in the HTML identical to the
 * tree of the URL being opened, which keeps later router operations consistent.
 */
export const SHELL_URLS = {
  home: "/w/_shell",
  page: "/w/_shell/p/_shell",
  trash: "/w/_shell/trash",
  graph: "/w/_shell/graph",
} as const;

export const ROOT_URL = "/";
/** Static fallback in public/ for navigations nothing else can answer (e.g. sign-in while offline). */
export const OFFLINE_URL = "/offline.html";

/** Documents the worker precaches in addition to the build assets and public/ files. */
export const PRECACHED_DOCUMENTS: readonly string[] = [ROOT_URL, ...Object.values(SHELL_URLS)];

/** Same grammar as `parseRoute` in lib/nav.tsx (a test keeps the two in sync). */
const WORKSPACE_RE = /^\/w\/([^/]+)(?:\/(?:p\/([^/]+)|(trash)|(graph)))?\/?$/;

export type ShellKind = keyof typeof SHELL_URLS;

export function shellKindForPath(pathname: string): ShellKind | null {
  const m = WORKSPACE_RE.exec(pathname);
  if (!m) return null;
  if (m[2]) return "page";
  if (m[3]) return "trash";
  if (m[4]) return "graph";
  return "home";
}

/**
 * The precached document that answers a navigation to `pathname` when neither network nor a cached copy of
 * that exact URL is available.
 */
export function navigationFallbackUrl(pathname: string): string {
  const kind = shellKindForPath(pathname);
  if (kind) return SHELL_URLS[kind];
  if (pathname === "/" || pathname === "") return ROOT_URL;
  return OFFLINE_URL;
}

// ----------------------------------------------------------------------------------------------------------
// Request classification
// ----------------------------------------------------------------------------------------------------------

export type RouteKind =
  /** Attachment download: cache-first. */
  | "file"
  /** Next.js RSC payload (client-side navigation / prefetch): network-first. */
  | "rsc"
  /** HTML document request: network-first with the app shell as offline fallback. */
  | "navigation"
  /** Hashed `/_next/static/*` asset: cache-first (immutable). */
  | "next-static"
  /** `/api/*` (everything except files) and `/collab`: network only, the worker stays out of the way. */
  | "network-only"
  /** Anything else (non-GET, cross-origin, precache-managed public files): not handled by a runtime rule. */
  | "ignore";

export interface RequestFacts {
  method: string;
  pathname: string;
  search?: string;
  sameOrigin: boolean;
  /** `request.mode` */
  mode?: string;
  /** Value of the `RSC` request header (Next.js sets "1" on RSC fetches). */
  rscHeader?: string | null;
}

const FILE_PATH_RE = /^\/api\/(?:files\/[^/]+|public\/[^/]+\/files\/[^/]+)\/?$/;

export function isFilePath(pathname: string): boolean {
  return FILE_PATH_RE.test(pathname);
}

export function classifyRequest(req: RequestFacts): RouteKind {
  if (!req.sameOrigin || req.method.toUpperCase() !== "GET") return "ignore";
  const { pathname } = req;

  if (isFilePath(pathname)) return "file";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "network-only";
  if (pathname === "/collab" || pathname.startsWith("/collab/")) return "network-only";
  if (pathname.startsWith("/_next/static/")) return "next-static";
  if (pathname.startsWith("/_next/")) return "ignore";
  // Check RSC before "navigation": Next.js sets mode "cors"/"same-origin" for these, but be explicit.
  if (req.rscHeader === "1" || /(?:^|[?&])_rsc=/.test(req.search ?? "")) return "rsc";
  if (req.mode === "navigate") return "navigation";
  return "ignore";
}

// ----------------------------------------------------------------------------------------------------------
// Response admission
// ----------------------------------------------------------------------------------------------------------

export interface ResponseFacts {
  status: number;
  /** `response.type` */
  type?: string;
  redirected?: boolean;
  headers: { get(name: string): string | null };
}

const CACHEABLE_FILE_TYPE_RE = /^(?:image|video|audio)\/|^application\/pdf\b/i;

/**
 * May this attachment response be stored for offline use?
 *
 * `Cache-Control: no-store` is deliberately NOT a reason to refuse: the API sends it on every attachment so that
 * browsers and proxies do not keep files around for other people. This cache is neither: it is private to the
 * signed-in user's browser profile, prefixed `hostidian-user-` and wiped on logout and on account change
 * (offline/cleanup.ts), and keeping images is the point of an offline notes app.
 */
export function isCacheableFileResponse(res: ResponseFacts, maxBytes = MAX_CACHED_FILE_BYTES): boolean {
  if (res.status !== 200 || res.type === "opaque" || res.type === "opaqueredirect") return false;
  if (res.headers.get("set-cookie")) return false;
  if (res.headers.get("vary")?.trim() === "*") return false;
  if (!CACHEABLE_FILE_TYPE_RE.test(res.headers.get("content-type") ?? "")) return false;
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) return false;
  return true;
}

/** May a navigation / RSC response be stored for offline use? */
export function isCacheableDocumentResponse(res: ResponseFacts): boolean {
  return (
    res.status === 200 &&
    res.type !== "opaque" &&
    !res.redirected && // a redirected response cannot satisfy a navigation request later
    !res.headers.get("set-cookie")
  );
}

/** Upstream failures (proxy restarts, 5xx) count as "network unavailable" for navigations. */
export function isServerFailure(status: number): boolean {
  return status >= 500;
}
