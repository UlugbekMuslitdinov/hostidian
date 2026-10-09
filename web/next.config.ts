import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Dev-only proxy target for the Go API. In production Caddy serves `/api/*` on the same origin,
// so the web container never proxies anything.
const apiTarget = (process.env.API_PROXY_TARGET ?? "http://localhost:8080").replace(/\/+$/, "");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Deliberately not a full CSP: Next.js inline bootstrap scripts need nonces (i.e. per-request
  // rendering), which would defeat the static, offline-capable app shell. Script policy is left open.
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // gzip middleware buffers proxied `text/event-stream` responses, which would stall live updates behind the
  // dev rewrite below. Production never proxies the API (Caddy does), so keep compression there.
  compress: process.env.NODE_ENV === "production",
  agentRules: false, // don't let `next dev` write AGENTS.md into the repo
  // Monorepo: trace from the workspace root so the standalone bundle includes @hostidian/* packages
  // (server entry ends up at .next/standalone/web/server.js).
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  transpilePackages: ["@hostidian/editor-schema", "@hostidian/api-types"],
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
