# Hostidian — self-hosted, collaborative, Notion-style notes (Obsidian alternative)

## Context
Obsidian is local-file based, so it lacks built-in sync, has no multi-user model, and has no real-time collaboration. Hostidian is an open-source, self-hosted app that fixes all three. Data lives on your server, so every device stays in sync automatically. One instance hosts many users and workspaces with page-level sharing and live co-editing. The UI is Notion-like and installs on phones as a PWA that keeps working offline. Everything ships as Docker containers.

The repo currently holds only a GoLand "hello world" stub (`main.go`, `go.mod` with `module hostidian`). This is a greenfield build.

**Decisions confirmed with you:** DB-first storage with Markdown import/export · real-time CRDT (Yjs) · Postgres · offline read and edit in the PWA · Go API plus a Node Hocuspocus collab sidecar · BlockNote editor · v1 extras: graph view, comments, public share links · local accounts plus optional OIDC.

**Defaults I chose (say so at approval to change):** license AGPL-3.0 · Go module `hostidian/backend` · invite-only signup by default · local-disk file storage (S3 later) · no version history in v1.

---

## Architecture

```
Browser (Next.js PWA: BlockNote + Yjs + y-indexeddb + Service Worker)
  ├─ /api/*   ─► Caddy ─► api    (Go :8080)          ─► Postgres
  ├─ /collab  ─► Caddy ─► collab (Hocuspocus :1234)  ─► Postgres (page_documents only)
  └─ /*       ─► Caddy ─► web    (Next.js :3000)
Internal-only docker network (Caddy blocks /internal*):
  collab ─► api:8081  /internal/pages/{id}/content   (push extracted markdown/plaintext/blocks/links)
  api    ─► collab:1235 /internal/markdown-to-ydoc   (used by import)
```

- **Single origin through Caddy.** Same-origin cookies and WebSockets. Caddy handles automatic HTTPS when `DOMAIN` is set, which the PWA needs off-localhost.
- **Go API (source of truth for everything except document bytes):** auth, users, workspaces, page tree, permissions, files, search, links/graph, comments, share links, import/export, SSE events.
- **Collab (Hocuspocus):** verifies a short-lived HS256 JWT (`sub`, `pageId`, `role`, `name`, `exp`) that Go issues at `POST /api/pages/{id}/collab-token`. Roles below `edit` get `connection.readOnly`. It checks `Origin`. It persists Yjs state to `page_documents` with debounced writes. In `onStoreDocument` it converts the Y.Doc into BlockNote blocks, then into Markdown, plaintext, and wikilink targets, and POSTs them to Go for search, backlinks, export, and public pages.
- **Page title and metadata** live in Postgres (REST). Content lives in the Y.Doc. Tree changes reach other clients through **SSE** (`GET /api/workspaces/{id}/events`, in-process broker, filtered by permission).
- **Offline:** y-indexeddb holds page contents. TanStack Query, persisted to IndexedDB, holds the tree and metadata. Paused mutations replay on reconnect. Page IDs are client-generated UUIDv7, so a page created offline can be opened and edited immediately. The Serwist service worker caches the app shell and RSC payloads.

### Permission model
- Workspace roles: `owner | admin | member | guest`. Page roles, ordered: `none < view < comment < edit < full`.
- Top-level pages are `workspace` (all members get `edit`) or `private` (creator only). Children inherit from their root.
- Explicit `page_permissions(user, role)` is inherited down the tree. Effective role = max(workspace base, nearest explicit grant on self or an ancestor). Owners and admins always get `full`. Guests see only pages explicitly shared with them.
- One Go resolver (recursive CTE) is used by every endpoint, search, graph, and SSE filtering. It is heavily unit-tested.

### Comments (block-anchored, Postgres-backed)
Threads are anchored to BlockNote block IDs and stored only in Postgres via REST, never inside the Y.Doc. This lets `comment`-role users comment while their collab connection stays read-only. UI: a comment button in the block side menu, count badges in the margin, and a right-hand thread panel. Threads whose block was deleted show as "detached". Live updates arrive over SSE.

### Wikilinks, backlinks, graph
- The shared BlockNote schema adds a `pageLink` inline node `{pageId, title}`. Typing `[[` opens a page picker that includes "create new page". The link always renders the page's *current* title from the client cache.
- Stored Markdown encodes a link as `[[hostidian:<uuid>|<title>]]`. The exporter rewrites it to `[[Current Title]]`, using a path if titles collide. The importer resolves `[[Title]]` / `[[Title|alias]]` against the imported set.
- Collab extraction fills `page_links`. Go serves backlinks and `/graph` (nodes and edges limited to visible pages). The web app renders the graph with `react-force-graph-2d`.

### Data model (`backend/migrations/00001_init.sql`)
`users`, `oidc_identities`, `sessions` (SHA-256 token hash, 30-day sliding expiry), `invites`, `instance_settings`, `workspaces`, `workspace_members`, `pages` (parent_id, fractional-index `position`, visibility, icon, cover, archived_at), `page_permissions`, `favorites`, `page_documents` (ydoc bytea), `page_content` (markdown, plaintext, blocks jsonb, generated weighted `tsvector` + GIN, trigram index on titles), `page_links`, `attachments`, `comment_threads`, `comments`, `share_links` (32-byte token, include_subpages, revoked_at), `import_jobs`.

### API contract — `api/openapi.yaml` (written first; drives codegen on both sides)
Go uses `oapi-codegen` (chi strict server plus types). TS uses `openapi-typescript` and `openapi-fetch` in `packages/api-types`.
- **Setup/auth:** setup status/create-admin, login/logout/me/register (invite or open signup), OIDC login/callback, providers, profile/password/sessions.
- **Admin:** users (disable, promote, reset link), settings (open signup), invites.
- **Workspaces:** CRUD, members, workspace invites, user lookup.
- **Pages:** tree list, create (client `id` allowed), get (role, breadcrumbs), patch, move `{parentId, beforeId|afterId}`, duplicate, archive/restore/purge, trash, favorites, recent, permissions + visibility, collab-token.
- **Content:** backlinks, graph, search (FTS with `ts_headline` snippets, trigram title quick-switch).
- **Files:** upload (multipart, size limit) and download (permission-checked, `nosniff`, risky types forced to attachment).
- **Comments:** threads, comments, resolve/reopen.
- **Shares:** CRUD share links. Public endpoints: page, subpage, file by token.
- **Import/export:** zip export of a page subtree or workspace (folders, `.md` with YAML frontmatter, `attachments/`). Async zip import job (Obsidian vault) with a status endpoint.
- **SSE events.** **Internal (port 8081, `INTERNAL_TOKEN`):** content ingestion.

### Tech stack
- **Go 1.26:** chi, pgx/v5, sqlc, goose (embedded, runs on start), oapi-codegen, x/crypto/argon2 (argon2id), golang-jwt/v5, coreos/go-oidc + x/oauth2 (PKCE/state/nonce), x/time/rate (login limiting), rocicorp/fracdex, slog, testcontainers-go.
- **Collab (Node 22, TS):** @hocuspocus/server + extension-database, yjs, @blocknote/server-util, jose, pg, vitest.
- **Web:** latest stable Next.js (App Router, React 19, standalone output), Tailwind v4, shadcn/ui, @blocknote/react + @blocknote/shadcn, @hocuspocus/provider, y-indexeddb, TanStack Query + persist-client + idb-keyval, openapi-fetch, dnd-kit (tree drag and drop), cmdk (⌘K), next-themes, sonner, frimousse (emoji), react-force-graph-2d, @serwist/next. Avoid `@blocknote/xl-*` packages.
- **Security basics:** HttpOnly/Secure/SameSite=Lax session cookie, Origin check on mutations and WebSocket, internal ports never published, secrets generated by `scripts/gen-env.sh`.

### Notion-like UX scope
Sidebar with workspace switcher, search, favorites, Workspace/Private sections, a drag-and-drop page tree, Trash, and Settings. Page header with emoji icon, cover, inline title, breadcrumbs, and a presence avatar stack from Yjs awareness. Share dialog for members and guests, roles, visibility, and public link. Page "…" menu: duplicate, move, export, copy link, delete. Slash menu, a callout block, and code blocks. ⌘K quick switcher, ⌘N new page, ⌘\ toggle sidebar. Dark mode. Mobile: sidebar as a drawer, touch-friendly tree, safe-area insets, and an install prompt.

---

## Repo layout
```
api/openapi.yaml            backend/ (cmd/hostidian, internal/{config,db,auth,oidc,workspaces,pages,perm,events,files,search,links,comments,shares,transfer,collabapi,httpapi}, migrations/, queries/, sqlc.yaml, Dockerfile)
collab/ (src/{server,auth,persistence,extract,import}.ts, Dockerfile)
web/ (src/app/{(auth),(app)/w/[slug]/p/[pageId],s/[token],setup,settings,admin}, src/components/{ui,layout,sidebar,editor,comments,graph,share}, src/lib/{api,offline,collab}, Dockerfile)
packages/editor-schema (shared BlockNote schema + md/wikilink transforms)   packages/api-types (generated)
docker-compose.yml  deploy/Caddyfile  .env.example  scripts/gen-env.sh  Makefile  pnpm-workspace.yaml
e2e/ (Playwright)  docs/{architecture.md,conventions.md}  .github/workflows/ci.yml  README.md  LICENSE
```
The root `main.go` and `go.mod` stub is deleted. `.idea/` is left alone.

---

## Execution plan (me plus Sonnet agents)

### Phase 0: Foundation (me, sequential, before any agent starts)
1. `git init`, `.gitignore`, delete the stub, create the monorepo skeleton and pnpm workspace.
2. Write the contracts that let agents work in parallel without colliding: `api/openapi.yaml` (complete), `backend/migrations/00001_init.sql` (complete), `docs/conventions.md` (error envelope `{error:{code,message}}`, UUIDv7, RFC3339, cursor pagination, fractional positions, SSE event names, JWT claims, internal payload shapes, stored-markdown link format), `docs/architecture.md`, `.env.example`, and the `packages/editor-schema` interface.
3. Checkpoint commit.

### Wave 1: four parallel background agents (disjoint directories)
| Agent | Owns | Delivers |
|---|---|---|
| **go-core** | `backend/` | Scaffold, config, pgx/goose/sqlc, oapi-codegen wiring, setup/auth/sessions/invites/admin/OIDC, workspaces/members, page tree (CRUD, move, trash, favorites, recent), permission resolver + tests, collab-token, SSE broker. Testcontainers integration tests. |
| **collab** | `collab/`, `packages/editor-schema/` | **Spike first:** Y.Doc ↔ blocks ↔ Markdown with the custom `pageLink` schema in Node. Then Hocuspocus with JWT auth, readOnly roles, Origin check, Postgres persistence, extraction push to Go, markdown-to-ydoc endpoint. Vitest. |
| **web-shell** | `web/` (except editor/PWA areas) | Next.js app, **installs every web dependency up front** (prevents lockfile races later), API client, auth/setup/invite pages, app layout, sidebar tree with dnd-kit + SSE, page header, ⌘K, share dialog, settings/admin, theme. |
| **infra** | Dockerfiles, compose, Caddy, Makefile, CI, scripts | Multi-stage images (distroless Go, Next standalone, slim Node), compose with healthchecks/volumes, Caddyfile, `make gen/dev/test/up`, GitHub Actions (lint, test, build, GHCR), README install section. |

After wave 1: I review the reports, fix contract drift, run every build and test, and make a checkpoint commit.

### Wave 2: three parallel agents (they can now run the real backend)
| Agent | Owns | Delivers |
|---|---|---|
| **go-features** | `backend/internal/{files,search,links,comments,shares,transfer,collabapi}` | Uploads/downloads, FTS + quick-switch search, content ingestion, backlinks, graph, comments, share links + public endpoints, zip export, async Obsidian-vault import. |
| **web-editor** | `web/src/components/{editor,comments,graph}`, page route, `s/[token]` | BlockNote + Hocuspocus + y-indexeddb, `[[` picker and pageLink rendering, uploads, presence, backlinks panel, comments panel, graph page, read-only public share page, import/export UI. |
| **pwa-offline** | `web/src/app/sw.ts`, `manifest.ts`, `public/icons`, `next.config`, `web/src/lib/offline`, `components/layout` | Serwist SW (shell + RSC caching, offline fallback), manifest and icons, persisted queries + paused mutations, offline create/rename, offline indicator, pre-caching of recent/favorite pages, mobile drawer and polish. |

After wave 2: review, integrate, checkpoint commit.

### Wave 3: integration and hardening (me + one **e2e** agent)
- I run `docker compose up --build` end-to-end and fix cross-service issues.
- The e2e agent writes Playwright tests in `e2e/` (scenarios below).
- I do a security pass (auth, permission checks on every endpoint, file serving, WS auth, share tokens) and finish the README (install, HTTPS/PWA via domain or Tailscale/Cloudflare tunnel, backups via `pg_dump` + files volume, OIDC setup).

**Agent briefs** include: the relevant plan sections, contract file paths, a strict directory-ownership rule (no edits outside owned paths; needed contract changes are reported, not made), a definition of done (build, lint, and tests pass), and a report format (what was built, deviations, open issues). All agents run with `model: "sonnet"` in the background.

---

## Key risks and mitigations
- **BlockNote server-side conversion with custom schema:** the collab agent spikes this first. The fallback is a vanilla `createInlineContentSpec` in the shared schema with React rendering overrides in web.
- **Serwist vs Next/Turbopack:** fall back to `next build --webpack` if needed.
- **Offline App-Router navigation:** the shell is client-rendered, RSC payloads are cached at runtime, and navigations fall back to the shell. Covered by an e2e test.
- **Permission leaks:** one resolver used everywhere, plus table-driven tests and e2e role tests.

## Verification
1. `make test`: Go unit and testcontainers integration tests (resolver, auth, invites, search, import/export), collab vitest (extraction, wikilinks, JWT), web typecheck, lint, and build.
2. `docker compose up --build` on a clean machine, then `https://localhost` → setup admin → workspace → page.
3. Playwright e2e:
   - (a) Setup, invite a second user, two browser contexts co-edit and see each other's text and presence.
   - (b) A `view` guest cannot type; a `comment` user can comment but not edit.
   - (c) `context.setOffline(true)` → edit and create a page → back online → the other client sees the changes.
   - (d) A public share link opens logged-out with images.
   - (e) Search finds body text.
   - (f) Export a zip containing `.md` with `[[links]]`, then re-import a sample Obsidian vault and verify links and backlinks resolve.
   - (g) Graph shows the edges.
4. PWA: Lighthouse installability (manifest, SW, HTTPS) and a Chrome device-mode check. Install on a real phone via a domain or Tailscale.
