# Rules for every implementation agent (read first)

You are one of several agents building **Hostidian** in parallel in the same repo: a self-hosted, multi-user, real-time collaborative notes app (Notion-style editor, Obsidian-style `[[links]]`/backlinks/graph, offline-capable PWA, Docker-first). Go API + Node collab server (Hocuspocus/Yjs) + Next.js web + Postgres + Caddy.

## Must-read (in this order, before writing code)
1. `docs/plan.md` — architecture, scope, execution waves.
2. `docs/conventions.md` — **the binding cross-service contract** (permissions, events, collab JWT, files, markdown dialect, search). If code and this file disagree, this file wins.
3. `api/openapi.yaml` (public REST, served under `/api`) and `api/internal.yaml` (service-to-service).
4. `backend/migrations/00001_init.sql` — the schema.
5. Anything specific to your task (named in your brief).

## Environment
- Repo root: `/Users/ulugbekmuslitdinov/Desktop/projects/hostidian` (macOS arm64). Go 1.26.4, pnpm 9.10.0, Docker 29 (Docker Desktop; testcontainers works). **Node 22 is required** (vitest 5, vite 8, jsdom 29, Hocuspocus 4 need >= 22.12; the shell default is v20.11 which can only run tsc/eslint). Always run Node/pnpm work with `export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"` (repo has `.nvmrc` = 22; Docker images use Node 22).
- pnpm workspace. **All dependencies for your package are already installed** (TypeScript ~5.9, ESLint ^9 — do NOT bump majors; typescript-eslint/eslint-config-next do not support TS 7 / ESLint 10).
- **Run every pnpm command through `scripts/pnpm.sh <args>`** (serializes access to `pnpm-lock.yaml` across parallel agents). If you need a new dependency, add it only to your own package: `scripts/pnpm.sh -F <pkg> add <dep>`; keep additions minimal and mainstream.
- Temp files/scripts go in the session scratchpad: `/private/tmp/claude-501/-Users-ulugbekmuslitdinov-Desktop-projects-hostidian/04f963ba-9d2d-4b30-836c-d3f3a3df41b1/scratchpad/` (create a subfolder named after you). Do not use `/tmp` or put scratch files in the repo.
- Other agents run at the same time. Only bind the default port of a service you own (api 8080/8081, collab 1234/1235, web 3000). Docker containers you start must be named `hostidian-<yourname>-*` and removed when you finish. testcontainers (random ports) is fine. Do not leave background processes running.

## Ownership & git
- **Only create/modify files inside the paths your brief says you own.** Never edit another agent's files. Never edit contract files: `api/*.yaml`, `docs/conventions.md`, `docs/plan.md`, `backend/migrations/00001_init.sql`, `.env.example`, `packages/api-types/src/schema.d.ts` (generated), root `package.json`/`pnpm-workspace.yaml`.
- If the contract is wrong, ambiguous or missing something: pick the smallest sensible interpretation, implement it, and list it under **Contract issues** in your final report. Do not silently diverge.
- **No git writes** (no add/commit/stash/checkout/reset/rebase). Read-only git (`status`, `diff`, `log`) is fine. The lead commits.
- Infra owns every `Dockerfile` and `.dockerignore` (including inside `backend/`, `collab/`, `web/`) — don't create those.

## Quality bar
- Production-quality code, not demos. No placeholder implementations dressed up as features; if something is deliberately deferred, say so in the report.
- Match the surrounding code's idiom, naming and comment density. Comment only the non-obvious *why*.
- Validate all external input; parameterized SQL only; constant-time compares for secrets; never log secrets/tokens/passwords; return the error envelope from conventions §1.
- TypeScript: strict; no `any`/`@ts-ignore` without a one-line justification. Go: `gofmt`, `go vet`, errors wrapped with context, `context.Context` plumbed through, no panics on bad input.
- Tests for the logic that matters (permissions, auth, parsing/transforms, data transforms). Failing tests are reported honestly, never deleted or skipped to get green.

## Definition of done
Everything in your brief's "Done when" list passes, run by you, with the real output checked. Then reply with the final report.

## Final report format (≤ 400 words, plain text)
1. **Built** — file/dir map of what exists now.
2. **Verified** — exact commands run and their results (pass/fail counts).
3. **Contract issues / deviations** — each with the decision you took.
4. **Gaps / follow-ups** — anything unfinished or for a later wave.
