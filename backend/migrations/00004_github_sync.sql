-- +goose Up
-- +goose StatementBegin

-- Two-way sync between a workspace and one GitHub repository's issues (docs/github-sync.md).
CREATE TABLE github_connections (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner              text        NOT NULL,
    repo               text        NOT NULL,
    token_enc          bytea       NOT NULL,                  -- AES-256-GCM (nonce || ciphertext), key derived from APP_SECRET
    webhook_secret_enc bytea       NOT NULL,                  -- same envelope; verifies X-Hub-Signature-256
    sync_user_id       uuid        NOT NULL REFERENCES users(id),  -- the user GitHub-originated edits are attributed to
    root_page_id       uuid        REFERENCES pages(id) ON DELETE SET NULL,  -- parent of every synced issue page
    enabled            boolean     NOT NULL DEFAULT true,
    issues_since       timestamptz,                           -- poll cursor: GitHub `since` for issues
    comments_since     timestamptz,                           -- poll cursor: GitHub `since` for issue comments
    backfilled_at      timestamptz,                           -- set once the initial import finished
    sync_requested_at  timestamptz,                           -- webhook / "sync now": pull on the next tick
    last_synced_at     timestamptz,
    last_error         text,
    last_error_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX github_connections_repo_idx ON github_connections (workspace_id, lower(owner), lower(repo));

-- One row per synced page. The base_* columns are the values both sides agreed on at the last sync: every
-- later change is classified against them (three-way merge), which is also what stops a write from echoing back.
CREATE TABLE github_issue_links (
    page_id                uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    connection_id          uuid        NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
    issue_number           integer     NOT NULL,
    html_url               text        NOT NULL,
    base_title             text        NOT NULL,
    base_state             text        NOT NULL CHECK (base_state IN ('open', 'closed')),
    base_local_body_hash   text        NOT NULL,              -- hash of the page Markdown as GitHub would receive it
    base_remote_body_hash  text        NOT NULL,              -- hash of the issue body as GitHub returned it
    remote_updated_at      timestamptz NOT NULL,              -- GitHub's updated_at at the last sync
    synced_page_updated_at timestamptz NOT NULL,              -- pages.updated_at at the last sync (local dirty marker)
    comment_thread_id      uuid        REFERENCES comment_threads(id) ON DELETE SET NULL,
    last_synced_at         timestamptz NOT NULL DEFAULT now(),
    sync_error             text,
    sync_error_at          timestamptz,
    UNIQUE (connection_id, issue_number)
);

-- Which Hostidian comment mirrors which GitHub comment.
CREATE TABLE github_comment_links (
    comment_id        uuid PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
    connection_id     uuid        NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
    github_comment_id bigint,                                 -- NULL for the local "linked to GitHub" intro comment
    origin            text        NOT NULL CHECK (origin IN ('github', 'hostidian', 'system')),
    remote_updated_at timestamptz,
    body_hash         text        NOT NULL DEFAULT '',
    UNIQUE (connection_id, github_comment_id)
);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS github_comment_links;
DROP TABLE IF EXISTS github_issue_links;
DROP TABLE IF EXISTS github_connections;
-- +goose StatementEnd
