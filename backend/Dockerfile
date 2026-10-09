# syntax=docker/dockerfile:1.7
#
# Hostidian API (Go). Build context: ./backend
#   docker build -t hostidian-api ./backend
#
# Multi-arch friendly: the compiler always runs on the build host ($BUILDPLATFORM) and cross-compiles
# (CGO is off), so `buildx --platform linux/amd64,linux/arm64` needs no emulation.

ARG GO_VERSION=1.26

# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
WORKDIR /src

# Dependencies first so this layer is cached until go.mod/go.sum change.
COPY go.mod go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags "-s -w -X hostidian/backend/internal/version.Version=${VERSION}" \
    -o /out/hostidian ./cmd/hostidian

# Data directory owned by the distroless "nonroot" user (uid/gid 65532). Docker copies this ownership
# into a fresh named volume on first use.
RUN mkdir -p /out/data

# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

ARG IMAGE_SOURCE=https://github.com/UlugbekMuslitdinov/hostidian
ARG VERSION=dev
LABEL org.opencontainers.image.title="hostidian-api" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.description="Hostidian API: auth, workspaces, pages, files, search, SSE (Go)" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.vendor="Hostidian"

COPY --from=build /out/hostidian /usr/local/bin/hostidian
COPY --from=build --chown=65532:65532 /out/data /data

ENV DATA_DIR=/data \
    API_ADDR=:8080 \
    INTERNAL_ADDR=:8081
VOLUME ["/data"]
USER 65532:65532
# 8080 = public API (behind Caddy at /api). 8081 = internal API (api <-> collab): never publish it.
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD ["/usr/local/bin/hostidian", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/hostidian"]
