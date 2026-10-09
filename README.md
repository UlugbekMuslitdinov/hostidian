# Hostidian

Self-hosted, multi-user, real-time collaborative notes — a Notion-style editor with Obsidian-style `[[links]]`, backlinks and graph, installable on your phone as an offline-capable PWA.

- **Automatic sync** between all your devices (the server is the source of truth; edits merge via Yjs CRDTs, even offline).
- **Users & access:** multiple users and workspaces per instance, page-level sharing, guests, public share links, comments.
- **Docker-first:** `docker compose up` brings up Postgres, the Go API, the collaboration server, the Next.js web app and Caddy (automatic HTTPS).
- **Open source:** AGPL-3.0.

> Status: under construction. See [`docs/plan.md`](docs/plan.md) for the roadmap and [`docs/architecture.md`](docs/architecture.md) for how it fits together.
