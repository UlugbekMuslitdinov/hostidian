# syntax=docker/dockerfile:1.7
#
# Hostidian collaboration server (Node, Hocuspocus/Yjs). Build context: the REPO ROOT (pnpm workspace):
#   docker build -f collab/Dockerfile -t hostidian-collab .
#
# Expects `pnpm -F @hostidian/collab build` to emit a self-contained bundle at collab/dist/server.js
# (workspace packages such as @hostidian/editor-schema inlined, npm dependencies kept external).
# Runtime node_modules come from `pnpm deploy --prod`, so no dev dependencies or sources ship.

ARG NODE_VERSION=22
ARG PNPM_VERSION=9.10.0

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS build

# Manifests only: the install layer stays cached until a dependency changes.
# (Keep this list in sync with pnpm-workspace.yaml; a missing member makes --frozen-lockfile fail.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY collab/package.json collab/
COPY web/package.json web/
COPY e2e/package.json e2e/
COPY packages/api-types/package.json packages/api-types/
COPY packages/editor-schema/package.json packages/editor-schema/

RUN --mount=type=cache,id=hostidian-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@hostidian/collab..."

# Sources (the rest of the repo is trimmed by .dockerignore; node_modules are never copied in).
COPY . .

RUN pnpm --filter @hostidian/collab build \
    && test -f collab/dist/server.js
# Production-only dependency tree (workspace deps are copied in, not symlinked), plus the bundle.
RUN --mount=type=cache,id=hostidian-pnpm-store,target=/pnpm/store \
    pnpm --filter @hostidian/collab deploy --prod /out \
    && mkdir -p /out/dist \
    && cp -r collab/dist/. /out/dist/

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ARG IMAGE_SOURCE=https://github.com/UlugbekMuslitdinov/hostidian
ARG VERSION=dev
LABEL org.opencontainers.image.title="hostidian-collab" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.description="Hostidian collaboration server: Hocuspocus/Yjs WebSocket sync and content extraction" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="Hostidian"

ENV NODE_ENV=production \
    COLLAB_PORT=1234 \
    COLLAB_INTERNAL_PORT=1235
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER 1000:1000
# 1234 = WebSocket (behind Caddy at /collab). 1235 = internal API (api <-> collab): never publish it.
EXPOSE 1234

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${COLLAB_INTERNAL_PORT}/internal/health" || exit 1

# `node` runs as PID 1 under compose's `init: true` (tini) so SIGTERM triggers the graceful flush.
CMD ["node", "dist/server.js"]
