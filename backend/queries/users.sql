-- name: CreateUser :one
INSERT INTO users (email, name, password_hash, avatar_color, is_instance_admin)
VALUES (@email, @name, sqlc.narg('password_hash'), @avatar_color, @is_instance_admin)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = @id;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE lower(email) = lower(@email::text);

-- name: UpdateUserProfile :one
UPDATE users SET
    name         = COALESCE(sqlc.narg('name'), name),
    avatar_color = COALESCE(sqlc.narg('avatar_color'), avatar_color),
    updated_at   = now()
WHERE id = @id
RETURNING *;

-- name: SetUserPassword :exec
UPDATE users SET password_hash = @password_hash, updated_at = now() WHERE id = @id;

-- name: UpdateUserAdminFields :one
UPDATE users SET
    disabled_at       = CASE WHEN sqlc.narg('disabled')::boolean IS NULL THEN disabled_at
                             WHEN sqlc.narg('disabled')::boolean THEN COALESCE(disabled_at, now())
                             ELSE NULL END,
    is_instance_admin = COALESCE(sqlc.narg('is_instance_admin'), is_instance_admin),
    updated_at        = now()
WHERE id = @id
RETURNING *;

-- Locks every enabled instance admin row so the "last admin" check and the update are atomic.
-- name: LockEnabledInstanceAdmins :many
SELECT id FROM users WHERE is_instance_admin AND disabled_at IS NULL ORDER BY id FOR UPDATE;

-- name: ListUsersForAdmin :many
SELECT u.id, u.email, u.name, u.avatar_color, u.is_instance_admin, u.disabled_at, u.created_at,
       (SELECT count(*) FROM workspace_members m WHERE m.user_id = u.id)::int AS workspace_count
FROM users u
ORDER BY u.created_at, u.id;

-- Most recent session activity per user (users without sessions have no row).
-- name: ListUsersLastSeen :many
SELECT s.user_id, max(s.last_seen_at)::timestamptz AS last_seen_at
FROM sessions s
GROUP BY s.user_id;

-- name: CreatePasswordReset :exec
INSERT INTO password_resets (token_hash, user_id, created_by, expires_at)
VALUES (@token_hash, @user_id, sqlc.narg('created_by'), @expires_at);

-- Consumes a valid reset token atomically (single use).
-- name: ConsumePasswordReset :one
UPDATE password_resets SET used_at = now()
WHERE token_hash = @token_hash AND used_at IS NULL AND expires_at > now()
RETURNING user_id;

-- name: DeleteStalePasswordResets :exec
DELETE FROM password_resets WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days';

-- name: GetOIDCIdentity :one
SELECT * FROM oidc_identities WHERE issuer = @issuer AND subject = @subject;

-- name: CreateOIDCIdentity :exec
INSERT INTO oidc_identities (user_id, issuer, subject, email)
VALUES (@user_id, @issuer, @subject, sqlc.narg('email'))
ON CONFLICT (issuer, subject) DO NOTHING;
