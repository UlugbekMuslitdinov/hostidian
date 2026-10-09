-- +goose Up
-- +goose StatementBegin

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Instance
-- ---------------------------------------------------------------------------
CREATE TABLE instance_settings (
    id                       boolean PRIMARY KEY DEFAULT true CHECK (id),  -- singleton row
    instance_name            text        NOT NULL DEFAULT 'Hostidian',
    allow_open_signup        boolean     NOT NULL DEFAULT false,
    allow_workspace_creation boolean     NOT NULL DEFAULT true,            -- non-admins may create workspaces
    updated_at               timestamptz NOT NULL DEFAULT now()
);
INSERT INTO instance_settings DEFAULT VALUES;

-- ---------------------------------------------------------------------------
-- Users & auth
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email             text        NOT NULL,
    name              text        NOT NULL,
    password_hash     text,                                   -- NULL for OIDC-only users
    avatar_color      text        NOT NULL DEFAULT '#6366f1',
    is_instance_admin boolean     NOT NULL DEFAULT false,
    disabled_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE oidc_identities (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer     text        NOT NULL,
    subject    text        NOT NULL,
    email      text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issuer, subject)
);
CREATE INDEX oidc_identities_user_idx ON oidc_identities (user_id);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   bytea       NOT NULL UNIQUE,                 -- SHA-256 of the cookie token
    user_agent   text        NOT NULL DEFAULT '',
    ip           text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE password_resets (
    token_hash bytea PRIMARY KEY,                             -- SHA-256 of the emailed/shown token
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    slug       text        NOT NULL UNIQUE,
    icon       text,
    created_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         text        NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE invites (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   bytea       NOT NULL UNIQUE,                 -- SHA-256 of the invite token
    token        text        NOT NULL,                        -- plain token so admins can re-copy the link
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role         text        NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
    email        text,                                        -- optional: restrict to this email
    created_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    used_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_workspace_idx ON invites (workspace_id);

-- ---------------------------------------------------------------------------
-- Pages
-- ---------------------------------------------------------------------------
CREATE TABLE pages (
    id             uuid PRIMARY KEY,                          -- may be client-generated (UUIDv7)
    workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id      uuid        REFERENCES pages(id) ON DELETE CASCADE,
    title          text        NOT NULL DEFAULT '',
    icon           text,                                      -- emoji or null
    cover          text,                                      -- preset id, color, or /api/files/<id>
    position       text        COLLATE "C" NOT NULL,          -- fractional index
    visibility     text        NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'private')),
    created_by     uuid        NOT NULL REFERENCES users(id),
    last_edited_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    archived_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    title_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, ''))) STORED
);
CREATE INDEX pages_workspace_parent_idx ON pages (workspace_id, parent_id);
CREATE INDEX pages_parent_idx ON pages (parent_id);
CREATE INDEX pages_archived_idx ON pages (workspace_id, archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX pages_updated_idx ON pages (workspace_id, updated_at DESC);
CREATE INDEX pages_title_tsv_idx ON pages USING gin (title_tsv);
CREATE INDEX pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops);

CREATE TABLE page_permissions (
    page_id    uuid        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text        NOT NULL CHECK (role IN ('view', 'comment', 'edit', 'full')),
    granted_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (page_id, user_id)
);
CREATE INDEX page_permissions_user_idx ON page_permissions (user_id);

CREATE TABLE favorites (
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    page_id    uuid        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, page_id)
);

-- Binary Yjs state. Written only by the collab service (plus copy/delete from the API).
CREATE TABLE page_documents (
    page_id    uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    ydoc       bytea       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Derived content (pushed by collab). Used for search, export, backlinks, public pages.
CREATE TABLE page_content (
    page_id    uuid PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    markdown   text        NOT NULL DEFAULT '',
    plaintext  text        NOT NULL DEFAULT '',
    blocks     jsonb       NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    body_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(plaintext, ''))) STORED
);
CREATE INDEX page_content_body_tsv_idx ON page_content USING gin (body_tsv);

CREATE TABLE page_links (
    source_page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    PRIMARY KEY (source_page_id, target_page_id)
);
CREATE INDEX page_links_target_idx ON page_links (target_page_id);

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- random: capability-style URL
    workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    page_id      uuid        REFERENCES pages(id) ON DELETE SET NULL,
    uploaded_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    filename     text        NOT NULL,
    content_type text        NOT NULL,
    size_bytes   bigint      NOT NULL,
    storage_key  text        NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_workspace_idx ON attachments (workspace_id);
CREATE INDEX attachments_page_idx ON attachments (page_id);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
CREATE TABLE comment_threads (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id     uuid        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_id    text        NOT NULL,                         -- BlockNote block id
    quote       text        NOT NULL DEFAULT '',              -- snippet of the block text at creation
    created_by  uuid        NOT NULL REFERENCES users(id),
    resolved_at timestamptz,
    resolved_by uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_threads_page_idx ON comment_threads (page_id);

CREATE TABLE comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id  uuid        NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
    author_id  uuid        NOT NULL REFERENCES users(id),
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_thread_idx ON comments (thread_id, created_at);

-- ---------------------------------------------------------------------------
-- Public share links
-- ---------------------------------------------------------------------------
CREATE TABLE share_links (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id          uuid        NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    token            text        NOT NULL UNIQUE,             -- 32 random bytes, base64url
    include_subpages boolean     NOT NULL DEFAULT false,
    created_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    revoked_at       timestamptz
);
CREATE INDEX share_links_page_idx ON share_links (page_id);

-- ---------------------------------------------------------------------------
-- Import jobs
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_page_id uuid        REFERENCES pages(id) ON DELETE SET NULL,
    status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    total          integer     NOT NULL DEFAULT 0,
    processed      integer     NOT NULL DEFAULT 0,
    error          text,
    result         jsonb,                                     -- {rootPageIds:[...], warnings:[...]}
    upload_path    text        NOT NULL,                      -- temp zip under $DATA_DIR/tmp
    created_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz
);
CREATE INDEX import_jobs_workspace_idx ON import_jobs (workspace_id, created_at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS import_jobs, share_links, comments, comment_threads, attachments,
    page_links, page_content, page_documents, favorites, page_permissions, pages,
    invites, workspace_members, workspaces, password_resets, sessions, oidc_identities,
    users, instance_settings CASCADE;
-- +goose StatementEnd
