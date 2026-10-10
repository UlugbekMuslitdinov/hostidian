# Connecting AI agents (MCP)

Hostidian speaks the [Model Context Protocol](https://modelcontextprotocol.io), so agents such as Claude Code, Claude
Desktop or Cursor can search, read and edit your pages. An agent acts **as you**: it sees exactly the pages you can see
and can do at most what you can do, never more. What it writes shows up live in the editor for anyone who has the page
open, and is attributed to you ("last edited by").

- Endpoint: `<PUBLIC_URL>/api/mcp` (MCP Streamable HTTP, stateless)
- Authentication: an **access token** (`hst_…`) sent as `Authorization: Bearer hst_…`
- Switch it off for the whole instance with `MCP_ENABLED=false` (the endpoint then answers `404`)

## 1. Create an access token

Open **Settings → Access tokens → Create token**, pick a name, a scope and optionally a workspace and an expiry, then
copy the token. **It is shown once**; Hostidian only keeps a hash. (The same is available over the API:
`POST /api/auth/tokens`, see `api/openapi.yaml`.)

| Choice | Meaning |
|---|---|
| **Scope `read`** | search and read only (`list_workspaces`, `search_pages`, `list_pages`, `get_page`, `get_backlinks`, `list_comments`) |
| **Scope `write`** | additionally create, edit, move, archive pages and add comments |
| **Workspace** | optional: the token only works inside that one workspace (other workspaces and their pages simply do not exist for it) |
| **Expiry** | optional, 1 to 365 days; after that the token stops working |

Start with `read`, restricted to one workspace, with an expiry. Revoke a token from the same screen: it stops working on
the very next request.

## 2. Connect a client

Replace `https://notes.example.com` with your `PUBLIC_URL` and `hst_…` with your token.

**Claude Code**

```sh
claude mcp add --transport http hostidian https://notes.example.com/api/mcp \
  --header "Authorization: Bearer hst_…"
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "hostidian": {
      "url": "https://notes.example.com/api/mcp",
      "headers": { "Authorization": "Bearer hst_…" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "hostidian": {
      "type": "http",
      "url": "https://notes.example.com/api/mcp",
      "headers": { "Authorization": "Bearer hst_…" }
    }
  }
}
```

**Claude Desktop** does not send custom headers to remote servers itself; bridge with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (needs Node.js). `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hostidian": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://notes.example.com/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer hst_…" }
    }
  }
}
```

**Any other client** needs only the URL and the header. A raw request, to test the token:

```sh
curl -s https://notes.example.com/api/mcp \
  -H "Authorization: Bearer hst_…" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Local development without TLS works the same with `http://localhost:8080/api/mcp` (or your `PUBLIC_URL`).

## 3. Tools

Inputs are JSON; ids are UUIDs. Results are JSON objects and list the `truncated` flag whenever a cap was hit.
Failures come back as MCP tool errors (`isError: true`) whose text starts with the API error code
(`not_found`, `forbidden`, `validation_failed`, `conflict`, `internal`), for example `not_found: Page not found.`

| Tool | Scope | Input | What it does |
|---|---|---|---|
| `list_workspaces` | read | - | Workspaces you (and the token) can access, with your role |
| `search_pages` | read | `workspace_id`, `query`, `mode?` (`full`\|`title`), `limit?` (1-50, default 20) | Ranked search with snippets (`**match**`) |
| `list_pages` | read | `workspace_id`, `parent_id?` | Flat list with `parentId` (max 500); `parent_id` limits it to the pages below that page |
| `get_page` | read | `page_id` | `{id, title, icon, role, breadcrumbs, updatedAt, markdown}` (Markdown capped at 1 MB) |
| `get_backlinks` | read | `page_id` | Pages that link to it |
| `list_comments` | read | `page_id`, `include_resolved?` | Comment threads |
| `create_page` | write | `workspace_id`, `title`, `parent_id?`, `icon?`, `markdown?` | New page, optionally with a body |
| `update_page` | write | `page_id`, `title?`, `icon?` | Rename / change icon (`""` removes it) |
| `edit_page_content` | write | `page_id`, `mode` (`replace`\|`append`\|`prepend`), `markdown` | Edit the body through the live document; returns the resulting Markdown |
| `move_page` | write | `page_id`, `parent_id?`, `after_id?` | Reparent / reorder (no `parent_id` = top level) |
| `archive_page` | write | `page_id` | Move to the Trash (recoverable; there is **no** hard-delete tool) |
| `add_comment` | write | `page_id`, `body`, `block_id?`, `thread_id?` | New thread (default: first block) or reply with `thread_id` |

Also available as a resource: `hostidian://pages/{page_id}` returns a page as Markdown.

**Markdown dialect.** Plain GitHub-flavoured Markdown plus the Hostidian extensions of `docs/conventions.md` section 8:
page links `[[hostidian:<page_id>|Title]]`, files `/api/files/<attachment_id>`, callouts `> [!note] text`
(`note|tip|warning|danger`).

**Freshness.** Reads (`get_page`, search, backlinks) come from the stored content, which can lag live typing by up to
about 10 seconds. `edit_page_content` always edits the live document and returns what the page looks like afterwards.
`replace` keeps the identity of unchanged blocks (comment anchors survive); `append`/`prepend` never disturb what
people are typing concurrently.

## 4. Security model

- **Acts as you.** Every call goes through the same permission resolver and services as the web app. Pages you cannot
  see answer "not found", as in the app. Instance admins get no extra reach.
- **Least privilege.** Scope `read`/`write` and the optional workspace restriction only ever narrow what you can do.
  A token never manages itself or your account: creating, listing and revoking tokens needs your browser session, and
  tokens are accepted **only** on `/api/mcp`, not on the REST API (so no profile, password, sessions, admin, invites,
  members, shares or workspace settings).
- **Storage.** Only the SHA-256 of a token is stored. The secret is shown once. A token expires when you set an expiry,
  stops working immediately when revoked, and stops when its owner is disabled.
- **Endpoint hardening.** Cookies are ignored on `/api/mcp` (no CSRF surface); if a request carries an `Origin` header it
  must be your `PUBLIC_URL` or an `ALLOWED_ORIGINS` entry (DNS-rebinding protection; non-browser clients send none);
  request bodies are capped at 4 MiB; each token may make 120 requests per minute.
- **Prompt injection.** Page text is written by people (and by other agents) and may contain instructions aimed at your
  agent. Tool descriptions tell the model to treat page content as data, but that is advice, not a guarantee. Mitigate
  it yourself: prefer `read` tokens, restrict tokens to one workspace, keep human approval on for write tools in your
  client, and review what an agent changed (pages an agent archives can be restored from the Trash).
- **Audit.** Every call is logged at info level with token id, user, tool, page id and outcome (never content or
  secrets): `{"msg":"mcp call","token_id":"…","tool":"edit_page_content","page_id":"…","outcome":"ok"}`.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` with `WWW-Authenticate: Bearer` | Missing, malformed, expired, revoked or unknown token, or its owner was disabled. Create a new token; check the header is `Authorization: Bearer hst_…` and that a proxy does not strip it. |
| `404` on `/api/mcp` | `MCP_ENABLED=false`, or the URL is wrong (it is `<PUBLIC_URL>/api/mcp`, no trailing path). |
| `403` "Cross-origin request blocked" | A browser-style `Origin` header that is not `PUBLIC_URL`/`ALLOWED_ORIGINS`. Command-line and desktop clients send none. |
| `429` | More than 120 requests per minute for that token; wait for `Retry-After`. |
| `413` | Request body over 4 MiB. |
| Tool error `not_found` | The page does not exist, you cannot see it, it is archived, or the token is restricted to another workspace. |
| Tool error `forbidden` | The token is read-only, or your role on that page is too low for the action. |
| Tool error `internal` on `edit_page_content` / `create_page` body | The collaboration service is unavailable (`COLLAB_INTERNAL_URL` unset or collab down). The page itself is created; retry the edit. |
| Claude Desktop shows no tools | Check `npx` works in a terminal, the URL/token, and the Claude Desktop MCP log. |
