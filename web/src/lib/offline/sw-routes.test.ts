import { describe, expect, it } from "vitest";
import { parseRoute } from "../nav";
import {
  CACHE_NAMES,
  OFFLINE_URL,
  PRECACHED_DOCUMENTS,
  ROOT_URL,
  SHELL_URLS,
  USER_DATA_CACHE_PREFIX,
  classifyRequest,
  isCacheableDocumentResponse,
  isCacheableFileResponse,
  isFilePath,
  isServerFailure,
  navigationFallbackUrl,
  shellKindForPath,
  type RequestFacts,
  type ResponseFacts,
} from "./sw-routes";

const get = (pathname: string, extra: Partial<RequestFacts> = {}): RequestFacts => ({
  method: "GET",
  pathname,
  sameOrigin: true,
  ...extra,
});

const res = (status: number, headers: Record<string, string> = {}, extra: Partial<ResponseFacts> = {}): ResponseFacts => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  ...extra,
});

describe("classifyRequest", () => {
  it("caches attachments (private and public share) cache-first", () => {
    expect(classifyRequest(get("/api/files/3f2a"))).toBe("file");
    expect(classifyRequest(get("/api/public/tok/files/abc"))).toBe("file");
  });

  it("never touches any other API or collab traffic", () => {
    for (const path of ["/api/auth/me", "/api/pages/1/collab-token", "/api/workspaces/1/events", "/api/files", "/api", "/collab", "/collab/x"]) {
      expect(classifyRequest(get(path)), path).toBe("network-only");
    }
  });

  it("ignores mutations and cross-origin requests", () => {
    expect(classifyRequest({ ...get("/api/files/x"), method: "POST" })).toBe("ignore");
    expect(classifyRequest({ ...get("/api/files/x"), sameOrigin: false })).toBe("ignore");
    expect(classifyRequest({ ...get("/"), sameOrigin: false, mode: "navigate" })).toBe("ignore");
  });

  it("treats hashed build assets as immutable and other /_next paths as the network's business", () => {
    expect(classifyRequest(get("/_next/static/chunks/a.js"))).toBe("next-static");
    expect(classifyRequest(get("/_next/image"))).toBe("ignore");
  });

  it("distinguishes RSC payloads from document navigations", () => {
    expect(classifyRequest(get("/w/acme", { rscHeader: "1" }))).toBe("rsc");
    expect(classifyRequest(get("/w/acme", { search: "?_rsc=abc" }))).toBe("rsc");
    expect(classifyRequest(get("/w/acme", { mode: "navigate" }))).toBe("navigation");
    expect(classifyRequest(get("/w/acme", { mode: "navigate", rscHeader: "1" }))).toBe("rsc");
    expect(classifyRequest(get("/icons/icon-192.png", { mode: "no-cors" }))).toBe("ignore");
  });
});

describe("isFilePath", () => {
  it("accepts exactly the attachment URLs", () => {
    expect(isFilePath("/api/files/abc")).toBe(true);
    expect(isFilePath("/api/files/abc/")).toBe(true);
    expect(isFilePath("/api/files/abc/extra")).toBe(false);
    expect(isFilePath("/api/public/tok/files/abc")).toBe(true);
    expect(isFilePath("/api/public/tok/page")).toBe(false);
  });
});

describe("response admission", () => {
  it("stores only complete, safe media files", () => {
    expect(isCacheableFileResponse(res(200, { "content-type": "image/png" }))).toBe(true);
    expect(isCacheableFileResponse(res(200, { "content-type": "application/pdf" }))).toBe(true);
    expect(isCacheableFileResponse(res(200, { "content-type": "video/mp4", "content-length": "1000" }))).toBe(true);
    expect(isCacheableFileResponse(res(206, { "content-type": "video/mp4" }))).toBe(false);
    expect(isCacheableFileResponse(res(404, { "content-type": "image/png" }))).toBe(false);
    expect(isCacheableFileResponse(res(200, { "content-type": "text/html" }))).toBe(false);
    expect(isCacheableFileResponse(res(200, { "content-type": "image/png", "set-cookie": "a=b" }))).toBe(false);
    // The API marks attachments no-store; the per-user, logout-wiped worker cache keeps them anyway (see sw-routes.ts).
    expect(isCacheableFileResponse(res(200, { "content-type": "image/png", "cache-control": "no-store" }))).toBe(true);
    expect(isCacheableFileResponse(res(200, { "content-type": "image/png", vary: "*" }))).toBe(false);
    expect(isCacheableFileResponse(res(200, { "content-type": "image/png" }, { type: "opaque" }))).toBe(false);
  });

  it("refuses files above the size limit", () => {
    const big = res(200, { "content-type": "image/png", "content-length": String(30 * 1024 * 1024) });
    expect(isCacheableFileResponse(big)).toBe(false);
    expect(isCacheableFileResponse(big, 50 * 1024 * 1024)).toBe(true);
  });

  it("stores documents only when they can stand in for a later navigation", () => {
    expect(isCacheableDocumentResponse(res(200))).toBe(true);
    expect(isCacheableDocumentResponse(res(200, {}, { redirected: true }))).toBe(false);
    expect(isCacheableDocumentResponse(res(200, { "set-cookie": "s=1" }))).toBe(false);
    expect(isCacheableDocumentResponse(res(404))).toBe(false);
    expect(isCacheableDocumentResponse(res(200, {}, { type: "opaque" }))).toBe(false);
  });

  it("counts 5xx as unavailable", () => {
    expect(isServerFailure(500)).toBe(true);
    expect(isServerFailure(503)).toBe(true);
    expect(isServerFailure(404)).toBe(false);
  });
});

describe("app shell fallback", () => {
  it("maps every workspace URL shape to its precached placeholder document", () => {
    expect(navigationFallbackUrl("/w/acme")).toBe(SHELL_URLS.home);
    expect(navigationFallbackUrl("/w/acme/")).toBe(SHELL_URLS.home);
    expect(navigationFallbackUrl("/w/acme/p/0190")).toBe(SHELL_URLS.page);
    expect(navigationFallbackUrl("/w/acme/trash")).toBe(SHELL_URLS.trash);
    expect(navigationFallbackUrl("/w/acme/graph")).toBe(SHELL_URLS.graph);
    expect(navigationFallbackUrl("/")).toBe(ROOT_URL);
  });

  it("falls back to the static offline page for everything else", () => {
    for (const path of ["/settings", "/login", "/admin/users", "/s/token", "/w/acme/unknown/x"]) {
      expect(navigationFallbackUrl(path), path).toBe(OFFLINE_URL);
    }
  });

  it("precaches the root and one document per shape", () => {
    expect(PRECACHED_DOCUMENTS).toEqual([ROOT_URL, SHELL_URLS.home, SHELL_URLS.page, SHELL_URLS.trash, SHELL_URLS.graph]);
  });

  it("agrees with the client router about which URLs are workspace routes", () => {
    const samples = ["/w/acme", "/w/acme/p/abc", "/w/acme/trash", "/w/acme/graph", "/settings", "/", "/login", "/w/a/b/c"];
    for (const path of samples) {
      expect(shellKindForPath(path) !== null, path).toBe(parseRoute(path).kind !== "other");
    }
  });
});

describe("cache names", () => {
  it("prefixes only per-user caches so logout can wipe exactly those", () => {
    expect(CACHE_NAMES.files.startsWith(USER_DATA_CACHE_PREFIX)).toBe(true);
    for (const name of [CACHE_NAMES.pages, CACHE_NAMES.rsc, CACHE_NAMES.nextStatic]) {
      expect(name.startsWith(USER_DATA_CACHE_PREFIX)).toBe(false);
    }
  });
});
