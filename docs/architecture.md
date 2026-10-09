# Hostidian architecture

Self-hosted, multi-user, real-time collaborative notes (Notion-like UI, Obsidian-style `[[links]]`/backlinks/graph), installable as an offline-capable PWA.

```
Browser (Next.js PWA: BlockNote + Yjs + y-indexeddb + Service Worker)
  ├─ /api/*   ─► Caddy ─► api    (Go :8080)          ─► Postgres
  ├─ /collab  ─► Caddy ─► collab (Hocuspocus :1234)  ─► Postgres (page_documents only)
  └─ /*       ─► Caddy ─► web    (Next.js :3000)

Internal docker network only (Caddy returns 404 for /internal*):
  collab ─► api:8081   PUT  /internal/pages/{id}/content      (extracted markdown/plaintext/blocks/links)
  api    ─► collab:1235 POST /internal/import-markdown         (used by import)
  api    ─► collab:1235 POST /internal/disconnect              (permission revocation)
```

## Services

| Service | Tech | Responsibility |
|---|---|---|
| `api` | Go 1.26, chi, pgx, sqlc, goose, oapi-codegen | auth, users, workspaces, page tree, permissions, files, search, links/graph, comments, shares, import/export, SSE. Runs migrations on start. |
| `collab` | Node 22, Hocuspocus, Yjs, `@blocknote/server-util` | WebSocket co-editing, Y.Doc persistence (`page_documents`), content extraction, Markdown→Y.Doc for import. |
| `web` | Next.js (App Router, standalone), Tailwind v4, shadcn/ui, BlockNote | UI, PWA (Serwist), offline cache. No server-side secrets; talks to the API through relative URLs. |
| `postgres` | postgres:17-alpine | all data (`pg_trgm` extension). |
| `caddy` | caddy:2 | single origin, TLS, routing, blocks `/internal*`. |

## Data ownership

- **Postgres via Go:** everything except `page_documents`.
- **`page_documents` (binary Yjs):** written only by `collab`.
- **Files:** local disk volume `$DATA_DIR/files` (api only).
- **Page title/metadata:** Postgres (REST). **Page content:** Y.Doc → derived `page_content` for search/export/public.

## Offline strategy (web)

- Page content: `y-indexeddb` per page document (edit offline, merge on reconnect via Yjs).
- Tree/metadata: TanStack Query persisted to IndexedDB; mutations are queued/paused offline and replayed.
- Offline create: client-generated UUIDv7 page ids (the API accepts them, idempotently).
- App shell + static assets + visited RSC payloads cached by the Serwist service worker; navigations fall back to the cached shell.

## Documents

- `docs/conventions.md` — the binding contract (permissions, events, collab, files, markdown, search).
- `api/openapi.yaml`, `api/internal.yaml` — HTTP contracts.
- `backend/migrations/00001_init.sql` — schema.
- `docs/plan.md` — the approved project plan (scope, execution waves, risks, verification).
