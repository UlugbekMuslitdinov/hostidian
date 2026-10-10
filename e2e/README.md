# @hostidian/e2e

Playwright end-to-end suite. It drives the **system Chrome** (`channel: "chrome"`, no browser download) against a
running Hostidian stack and arranges state through the public REST API.

## Run it against a local compose stack

Use ports that don't collide with your dev servers (the example uses 20080/20443). `DOMAIN` must be `:<HTTP_PORT>`
so Caddy listens on the published port; plain HTTP on `localhost` is a secure context, so the PWA APIs work.

```sh
./scripts/gen-env.sh -y -d localhost -o /tmp/e2e.env
sed -i '' -e 's#^DOMAIN=.*#DOMAIN=:20080#' -e 's#^PUBLIC_URL=.*#PUBLIC_URL=http://localhost:20080#' \
          -e 's#^HTTP_PORT=.*#HTTP_PORT=20080#' -e 's#^HTTPS_PORT=.*#HTTPS_PORT=20443#' /tmp/e2e.env   # GNU sed: drop the ''
docker compose --env-file /tmp/e2e.env -p hostidian-e2e up -d --build --wait

export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"      # Node >= 22.12
E2E_BASE_URL=http://localhost:20080 scripts/pnpm.sh -F @hostidian/e2e test
# a single spec / headed / debug:
E2E_BASE_URL=http://localhost:20080 pnpm -F @hostidian/e2e exec playwright test tests/comments.spec.ts --headed

docker compose --env-file /tmp/e2e.env -p hostidian-e2e down -v   # tear down (drops the database)
```

`E2E_BASE_URL` must equal the stack's `PUBLIC_URL` (the API checks `Origin`). Other knobs: `E2E_WORKERS` (default 3),
`E2E_RETRIES` (default 0), `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`.

The suite can be repeated against the same stack: the `onboarding` project creates the instance admin through the real
setup form on a fresh stack, or signs in with the same credentials on a stack that already has it, and saves the session
to `.auth/admin.json` (git-ignored). Every test then works in its **own workspace** with its own users, so tests are
independent, parallel-safe and leave nothing that another test can trip over.

## Layout

| Path | What |
|---|---|
| `playwright.config.ts` | `onboarding` project (first), then `chrome` (depends on it) |
| `helpers/api.ts` | typed REST client for arranging/reading state (`Api`) |
| `helpers/fixtures.ts` | `test` with `team` (isolated workspace + owner, `addUser`, `importVault`) and `adminApi`; `Actor.newPage()` opens a browser context as that user |
| `helpers/ui.ts` | editor helpers (`openPage` waits for a live collab session, `typeAtEnd`, `pasteImage`, `startCommentOn`, `deleteBlock`) |
| `helpers/vault.ts` | build/read zips (`buildVault`, `zipText`), generate PNGs |
| `helpers/names.ts` | `uniqueName()` / `uniqueWord()` / `uniqueEmail()` |
| `tests/*.spec.ts` | one file per area (see below) |

Tests use web-first assertions and `expect.poll` only; there are no fixed sleeps. Pages with content are created through
the import API (`team.importVault`) because that is far faster than typing and exercises the real Markdown -> Y.Doc ->
extraction pipeline. Anything the plan calls a UI behaviour is driven through the UI.

## Scenarios (docs/plan.md "Verification")

| Plan | Spec |
|---|---|
| (a) setup, two contexts co-edit, presence | `onboarding`, `collaboration` |
| (b) `view` guest can't type, `comment` user can comment | `roles` |
| (d) public link logged-out incl. image, revoked -> 404 | `public-share` |
| (e) search finds body text | `search` |
| (f) export zip with `[[links]]`, re-import, backlinks | `import-export`, `page-links` |
| (g) graph shows the edges | `graph` |
| comments, uploads, light/dark, phone layout | `comments`, `uploads`, `appearance` |
| (c) offline, PWA | added by the pwa-offline work (`offline.spec.ts`, `pwa.spec.ts`) on top of these helpers |

## CI

The generic recursive `typecheck/lint/test/build` runs exclude this package. Add a job that starts the compose stack as
above, waits for `--wait`, runs `pnpm -F @hostidian/e2e test`, and uploads `e2e/playwright-report` and
`e2e/test-results` on failure (the config writes an HTML report when `CI` is set).
