# syntax=docker/dockerfile:1.7
#
# Hostidian web app (Next.js standalone). Build context: the REPO ROOT (pnpm workspace):
#   docker build -f web/Dockerfile -t hostidian-web .
#
# Relies on `output: "standalone"` in web/next.config.*. Because web/ lives inside a monorepo, Next traces
# files from the workspace root, so the server entry ends up at .next/standalone/web/server.js
# (set outputFileTracingRoot to the repo root if you override it). The build fails loudly if that changes.

ARG NODE_VERSION=22
ARG PNPM_VERSION=9.10.0

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat \
    && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
FROM base AS build

# Manifests only: the install layer stays cached until a dependency changes.
# (Keep this list in sync with pnpm-workspace.yaml; a missing member makes --frozen-lockfile fail.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
COPY collab/package.json collab/
COPY e2e/package.json e2e/
COPY packages/api-types/package.json packages/api-types/
COPY packages/editor-schema/package.json packages/editor-schema/

RUN --mount=type=cache,id=hostidian-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@hostidian/web..."

# Sources, including the workspace packages the web app transpiles (api-types is generated code that
# is checked in). The rest of the repo is trimmed by .dockerignore; node_modules are never copied in.
COPY . .

# No server-side secrets and no NEXT_PUBLIC_* values are needed: the app only uses relative URLs.
RUN mkdir -p web/public && pnpm --filter @hostidian/web build
RUN test -f web/.next/standalone/web/server.js \
    || { echo "ERROR: expected web/.next/standalone/web/server.js (needs output: 'standalone' and the monorepo root as tracing root)"; exit 1; }

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ARG IMAGE_SOURCE=https://github.com/UlugbekMuslitdinov/hostidian
ARG VERSION=dev
LABEL org.opencontainers.image.title="hostidian-web" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.description="Hostidian web app: Next.js PWA front end" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="Hostidian"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/web/.next/static ./web/.next/static
COPY --from=build --chown=node:node /repo/web/public ./web/public
USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1

CMD ["node", "web/server.js"]
