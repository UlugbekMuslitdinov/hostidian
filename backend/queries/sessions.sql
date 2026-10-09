-- name: CreateSession :one
INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
VALUES (@user_id, @token_hash, @user_agent, @ip, @expires_at)
RETURNING *;

-- Valid (unexpired) session of an enabled user.
-- name: GetSessionByTokenHash :one
SELECT sqlc.embed(s), sqlc.embed(u)
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = @token_hash AND s.expires_at > now() AND u.disabled_at IS NULL;

-- name: TouchSession :exec
UPDATE sessions SET last_seen_at = @now, expires_at = @expires_at WHERE id = @id;

-- name: ListSessionsForUser :many
SELECT * FROM sessions WHERE user_id = @user_id AND expires_at > now() ORDER BY last_seen_at DESC, id;

-- name: DeleteSession :execrows
DELETE FROM sessions WHERE id = @id AND user_id = @user_id;

-- name: DeleteSessionByTokenHash :exec
DELETE FROM sessions WHERE token_hash = @token_hash;

-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id = @user_id;

-- name: DeleteUserSessionsExcept :exec
DELETE FROM sessions WHERE user_id = @user_id AND id <> @keep_id;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at < now();

-- name: DeleteSessionByID :exec
DELETE FROM sessions WHERE id = @id;
