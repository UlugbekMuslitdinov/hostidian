-- Personal access tokens for MCP clients (conventions §13). Only the SHA-256 of a token is stored.

-- name: InsertApiToken :one
INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, scope, workspace_id, expires_at)
VALUES (@user_id, @name, @token_hash, @token_prefix, @scope, @workspace_id, @expires_at)
RETURNING *;

-- The caller's tokens that were not revoked, newest first. Never includes the hash.
-- name: ListApiTokensForUser :many
SELECT id, user_id, name, token_prefix, scope, workspace_id, expires_at, last_used_at, created_at
FROM api_tokens
WHERE user_id = @user_id AND revoked_at IS NULL
ORDER BY created_at DESC, id;

-- Active (not revoked, not expired) tokens, for the per-user cap.
-- name: CountActiveApiTokens :one
SELECT count(*)::int FROM api_tokens
WHERE user_id = @user_id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- name: RevokeApiToken :execrows
UPDATE api_tokens SET revoked_at = now()
WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL;

-- A usable token: not revoked, not expired, owner not disabled.
-- name: GetUsableApiTokenByHash :one
SELECT t.id, t.user_id, t.scope, t.workspace_id, t.last_used_at
FROM api_tokens t
JOIN users u ON u.id = t.user_id
WHERE t.token_hash = @token_hash
  AND t.revoked_at IS NULL
  AND (t.expires_at IS NULL OR t.expires_at > now())
  AND u.disabled_at IS NULL;

-- At most one write per token every 5 minutes, even across API instances.
-- name: TouchApiToken :exec
UPDATE api_tokens SET last_used_at = now()
WHERE id = @id AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes');
