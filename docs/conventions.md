# Hostidian conventions (the contract every service follows)

If code and this file disagree, **this file wins** — fix the code, or ask for the contract to be changed. Do not silently diverge.

Related: `api/openapi.yaml` (public REST API), `api/internal.yaml` (service-to-service), `backend/migrations/00001_init.sql` (schema), `docs/architecture.md`.

## 1. General

- **IDs:** all primary keys are UUIDs. Pages may be created with a **client-generated UUIDv7** (needed for offline create). Attachments, comments, sessions, etc. use server-generated random UUIDv4 (`gen_random_uuid()`); attachment ids must stay unguessable (see §7).
- **Timestamps:** RFC 3339 UTC strings in JSON (`2026-10-09T12:00:00Z`); `timestamptz` in Postgres.
- **JSON casing:** `camelCase` in all JSON. `snake_case` in SQL.
- **Lists** are plain JSON arrays and unpaginated in v1 (search/recent accept `limit`).
- **Error envelope** (every non-2xx response from the public and internal API):
  ```json
  { "error": { "code": "forbidden", "message": "You do not have access to this page." } }
  ```
  | HTTP | `code` | Use |
  |---|---|---|
  | 400 | `bad_request` | malformed JSON / params |
  | 401 | `unauthorized` | no/invalid session |
  | 403 | `forbidden` | authenticated but not allowed |
  | 404 | `not_found` | missing **or not visible** (never reveal existence of pages the user cannot see) |
  | 409 | `conflict` | uniqueness / state conflicts |
  | 413 | `payload_too_large` | upload over limit |
  | 422 | `validation_failed` | semantic validation (may include `details: {field: msg}`) |
  | 429 | `rate_limited` | login/register limiter |
  | 500 | `internal` | never leak internals |
- **Base paths:** public API is served under `/api` (spec `servers: [{url: /api}]`; paths in the spec do **not** include the prefix). Internal API is on a separate port, never routed by Caddy.
- **Go module path:** `hostidian/backend`. Layout is fixed in the plan (`backend/internal/...`).

## 2. Auth & sessions

- Cookie `hostidian_session`: 32 random bytes, base64url. DB stores **SHA-256(token)** in `sessions.token_hash`. Attributes: `HttpOnly; SameSite=Lax; Path=/; Secure` (Secure when `PUBLIC_URL` is https). Sliding expiry 30 days; `last_seen_at` updated at most every 5 minutes.
- Passwords: argon2id (memory 64 MiB, t=3, p=2), PHC string in `users.password_hash`. Min length 10. OIDC-only users have `password_hash IS NULL`.
- **CSRF:** all non-GET/HEAD/OPTIONS requests (and WebSocket/SSE upgrades) must carry an `Origin` header whose origin equals the origin of `PUBLIC_URL` or is in `ALLOWED_ORIGINS`; otherwise 403. Requests with no `Origin` and no session cookie (e.g. login from curl) are allowed only for `/auth/login`, `/setup`, `/auth/register`.
- **Rate limit:** login/register/password-reset: 10 attempts / 15 min per (IP + lowercased email), in-memory.
- **Instance admin** (`users.is_instance_admin`): the first user created via `POST /setup`. `/setup` returns 409 once any user exists.
- **Signup policy:** `instance_settings.allow_open_signup` (default false). If false, `/auth/register` requires a valid invite token. Invites always target one workspace and one role.
- **OIDC:** optional; enabled iff `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` are all set. Authorization-code + PKCE + state + nonce. Match existing users by `(issuer, subject)`; otherwise link to an existing user with the same email **only if `email_verified` is true**; otherwise create a user only if open signup is on or a valid `invite` token was passed to `/auth/oidc/login?invite=…`.
- Disabled users (`disabled_at` set): all sessions rejected; collab connections closed (§6).

## 3. Permissions (single source of truth: `backend/internal/perm`)

- Workspace roles: `owner | admin | member | guest`.
- Page roles, ordered: `none < view < comment < edit < full`.
- Each **root page** (parent_id NULL) has `visibility`: `workspace` (every non-guest workspace member has base role `edit`) or `private` (creator has `full`, nobody else unless granted). **Child pages inherit** access from their root plus explicit grants; `visibility` is only meaningful on roots (children store the default `workspace` and ignore it).
- `page_permissions(page_id, user_id, role)` grants are inherited down the tree. **Effective role** =
  `max(base, nearest explicit grant on the page or any ancestor (the nearest grant wins, but never lowers below base))`, where:
  - workspace `owner`/`admin` → always `full` on every page in the workspace (including private pages — documented trade-off),
  - base for `workspace` visibility and role `member` → `edit`; for `guest` → `none`,
  - base for `private` roots → `full` for `created_by`, else `none`.
  - **Creator ownership:** the user in `pages.created_by` holds an implicit `full` grant on that page, inherited by its descendants like any explicit grant (so members can archive/share/delete the pages they created). At the same level the implicit grant is combined with an explicit one by `max`; a nearer explicit grant on a descendant (e.g. an explicit `view` for the creator) still overrides it per the nearest-wins rule. Guests who created a page (via a `full`/`edit` grant) get the same.
  - Instance admins have **no** implicit access to workspaces they are not members of.
- `view` = read; `comment` = read + comment; `edit` = + edit content/title/move children/upload; `full` = + share, permissions, delete/archive, visibility.
- **404 not 403** when effective role is `none` (do not reveal existence). 403 when role is insufficient but ≥ `view`.
- One resolver (recursive CTE) is used by **every** endpoint, search, graph, backlinks, SSE filtering and public-share checks. No ad-hoc permission SQL elsewhere.
- Archived pages: `pages.archived_at` is set on the whole archived subtree with the **same timestamp**. Restore reverses exactly the rows with that timestamp. Archived pages are excluded from tree/search/graph/backlinks; listed in trash for users with `full`. Purge (`DELETE /pages/{id}`) is only allowed on archived pages and cascades.

## 4. Page tree & ordering

- `pages.position` is a **fractional index string** (Go: `roci.dev/fracdex`; TS: `fractional-indexing` — same algorithm). Siblings are ordered by `(position COLLATE "C", id)`. Collation must be `"C"` (the column is declared that way in the schema).
- `POST /pages/{id}/move` takes `{parentId, afterId?, beforeId?}`; the server computes the new position. Omitting both appends. Cycles (moving into own descendant) → 422.
- Clients may compute an optimistic position locally but the server value always wins; the next tree fetch/SSE event overrides.
- Page **title and metadata live in Postgres** (REST). Page **content lives in the Y.Doc** (collab). The Y.Doc has no title block.

## 5. Real-time events (SSE)

`GET /workspaces/{id}/events` → `text/event-stream`. Heartbeat comment `: ping` every 25 s. Each message:
```
event: page.updated
data: {"type":"page.updated","workspaceId":"…","pageId":"…","actorId":"…","at":"…","data":{…}}
```
Event types: `page.created`, `page.updated` (metadata or content changed; `data` is a `PageSummary` when metadata changed), `page.moved`, `page.archived`, `page.restored`, `page.deleted`, `permissions.changed` (client must refetch the tree), `comment.created`, `comment.updated`, `comment.resolved`, `comment.deleted` (`data: {threadId}`), `member.changed`.

Rules: (1) **never send an event about a page the subscriber cannot view** (the broker checks the resolver; on `permissions.changed` it re-evaluates); (2) events are hints — on reconnect clients refetch; no replay/`Last-Event-ID`; (3) the in-process broker is single-instance (no Redis in v1).

## 6. Collaboration service

- WebSocket via Caddy at `/collab`. Hocuspocus document name = `page:<pageId>`.
- Go issues a **collab JWT** at `POST /pages/{id}/collab-token` (requires ≥ `view`). HS256, secret `COLLAB_JWT_SECRET`. Claims: `iss="hostidian-api"`, `aud="hostidian-collab"`, `sub=<userId>`, `pageId`, `role` (`view|comment|edit|full`), `name`, `color` (hex avatar color), `iat`, `exp` (= iat + 120 s; used **only at connect time**).
- Collab rejects the connection if `pageId` doesn't match the document name, the token is expired/invalid, or `Origin` is not allowed. Roles `view`/`comment` ⇒ `connection.readOnly = true`.
- **Revocation:** when permissions change or a user is disabled/removed, Go calls collab `POST /internal/disconnect` (`api/internal.yaml`) so live sockets are closed; the client then re-requests a token and gets the new role (or 404).
- **Persistence:** collab writes the binary Yjs state to `page_documents.ydoc` (debounced 2 s, max 10 s) — it is the only service that writes that table (plus `duplicate`/`purge` in Go which copy/delete the row).
- **Extraction push:** after each store, collab converts the doc to blocks → Markdown + plaintext + link targets and calls Go `PUT /internal/pages/{pageId}/content` (`api/internal.yaml`). Go writes `page_content`, replaces `page_links` (keeping only targets that exist in the same workspace), bumps `pages.updated_at`/`last_edited_by`, and emits `page.updated`.
- Awareness: user `{id, name, color}` so clients render presence avatars.
- Y.Doc root fragment name: `"blocknote"` (BlockNote's default for `collaboration.fragment = doc.getXmlFragment("blocknote")`). Same constant exported from `packages/editor-schema`.
- Service-to-service auth: header `Authorization: Bearer <INTERNAL_TOKEN>`.

## 7. Files / attachments

- Stored on local disk under `$DATA_DIR/files/<aa>/<uuid>` (`aa` = first two chars of the id); `attachments.storage_key` holds the relative path. Max size `MAX_UPLOAD_MB` (default 50) enforced with `http.MaxBytesReader`.
- The attachment id equals the file name under `files/<aa>/`. An hourly janitor deletes attachments (row + file) that no page references (markdown, block JSON or cover) and files with no row, once they are older than 24 h.
- Public pages: page links to pages outside the shared subtree are replaced by the text "unavailable page" server-side, so titles of unshared pages never leak.
- Referenced in documents as `/api/files/<attachmentId>` (relative URL, no query). Public pages use `/api/public/<token>/files/<attachmentId>`.
- Download access: caller must be a non-guest member of the attachment's workspace, **or** (guest) have ≥ `view` on `attachments.page_id`. Attachment ids are random UUIDv4 (capability-style); this is intentional so duplicated/moved pages keep working.
- Serve with `X-Content-Type-Options: nosniff`; `Content-Disposition: inline` only for `image/png|jpeg|gif|webp|avif`, `video/mp4|webm`, `audio/*`, `application/pdf`; everything else (incl. SVG, HTML) is `attachment`. Never trust the client content type — sniff with `http.DetectContentType` and store the sniffed type for inline decisions. Sanitize filenames.

## 8. Markdown format

Stored in `page_content.markdown` (GitHub-flavoured, from BlockNote's `blocksToMarkdownLossy`), plus these extensions:
- Page links: `[[hostidian:<pageUuid>|<title at time of save>]]`. Inside the title, `\` and `]` are escaped as `\\` and `\]`; inside a GFM table row `|` is escaped as `\|` (also the separator). Go must parse with: `\[\[hostidian:([0-9a-f-]{36})\\?\|((?:\\.|[^\]\\])*)\]\]` (group 2 = escaped title; unescape `\x` → `x`).
- Audio/video blocks export as plain links `[name](url)`; captioned images as `![caption](url)`. Export is **lossy** by design (no underline/colour; BlockNote does not escape Markdown characters) — `page_content.blocks` (JSON) is the lossless representation, Markdown is for search/export/import.
- Images: `![alt](/api/files/<attachmentId>)`; other files: `[name](/api/files/<attachmentId>)`
- Callout block: `> [!note] text` (Obsidian/GitHub style callouts; `note|tip|warning|danger`)
- Internal `plaintext` is the visible text only (no markup), used for FTS.

**Export** (Go, from `page_content.markdown` + DB titles): zip with folders mirroring the page tree; each page → `<Title>.md` (sanitized, deduped with ` (2)`), children in a folder of the same name; YAML frontmatter `id, title, icon, created, updated`; page links rewritten to `[[Current Title]]` (or `[[Folder/Title]]` when titles collide); `/api/files/<id>` → `attachments/<id8>-<filename>` relative links.
**Import** (Go parses the zip; Obsidian vault compatible): folders → pages; `Folder/Folder.md` becomes the folder's page body; `.md` files → pages (title from frontmatter `title` else filename); `[[Title]]`, `[[Title|alias]]`, `[[Title#Heading]]` resolved against imported titles (case-insensitive, nearest path wins) → stored format; `![[img.png]]` and `![](img.png)` → attachments; unresolved links stay as plain text. Go then calls collab `POST /internal/import-markdown` per page to produce the Y.Doc.

## 9. Search

- Postgres FTS with the **`simple`** text-search config (language-agnostic). Title: `pages.title_tsv` (weight A). Body: `page_content.body_tsv` (weight B). Rank with `ts_rank_cd`; snippets via `ts_headline('simple', plaintext, query, 'MaxFragments=2,MaxWords=20,MinWords=5')`. Query parsing: `websearch_to_tsquery('simple', q)` with prefix matching on the last token.
- Quick switcher (`mode=title`): `pages.title % q` / `ILIKE` with `pg_trgm`, ordered by `similarity`, then recency.
- Results are filtered through the permission resolver in SQL.

## 10. Comments

- Thread = `(page_id, block_id, quote, resolved_at)`; comments belong to a thread. `block_id` = BlockNote block id (string). Authors can edit/delete their comments; `full` role can delete any. Resolve/reopen requires ≥ `comment`. Deleting the last comment deletes the thread. Needs ≥ `comment` to create; ≥ `view` to read.

## 11. Public shares

- `share_links.token` is a 32-byte random value, base64url (stored plain so the UI can show/copy it again). Public URL: `/s/<token>`. `include_subpages` controls whether descendants are reachable. `revoked_at` disables. Public endpoints never require a session, return **read-only** data only (title/icon/cover/blocks/tree of the shared subtree) and never expose emails or user ids.
- Public pages render the `blocks` JSON read-only with the shared editor schema.

## 12. Testing & quality bar (definition of done for every agent)

- Go: `go vet ./...`, `gofmt`, `go test ./...` pass; integration tests use `testcontainers-go` with `postgres:17-alpine`.
- TS: `pnpm -F <pkg> typecheck`, `lint`, `test` pass; no `any` without a comment.
- No secrets in code; config only via env (see `.env.example`).
- Keep commits to the agent's own directories; **do not edit files you don't own** (report needed contract changes instead).
