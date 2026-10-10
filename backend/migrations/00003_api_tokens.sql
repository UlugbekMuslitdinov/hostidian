-- +goose Up
-- +goose StatementBegin

-- Personal access tokens for MCP clients / agents acting on behalf of a user (conventions §13).
CREATE TABLE api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         text        NOT NULL,
    token_hash   bytea       NOT NULL UNIQUE,                   -- SHA-256 of the full token (hst_…)
    token_prefix text        NOT NULL,                          -- first characters, for display only
    scope        text        NOT NULL CHECK (scope IN ('read', 'write')),
    workspace_id uuid        REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = all of the user's workspaces
    expires_at   timestamptz,
    last_used_at timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS api_tokens;
-- +goose StatementEnd
