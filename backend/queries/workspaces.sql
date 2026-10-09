-- name: CreateWorkspace :one
INSERT INTO workspaces (name, slug, icon, created_by)
VALUES (@name, @slug, sqlc.narg('icon'), sqlc.narg('created_by'))
RETURNING *;

-- name: GetWorkspace :one
SELECT * FROM workspaces WHERE id = @id;

-- name: WorkspaceSlugExists :one
SELECT EXISTS (SELECT 1 FROM workspaces WHERE slug = @slug);

-- name: UpdateWorkspace :one
UPDATE workspaces SET
    name       = COALESCE(sqlc.narg('name'), name),
    slug       = COALESCE(sqlc.narg('slug'), slug),
    icon       = CASE WHEN @set_icon::boolean THEN sqlc.narg('icon') ELSE icon END,
    updated_at = now()
WHERE id = @id
RETURNING *;

-- name: DeleteWorkspace :exec
DELETE FROM workspaces WHERE id = @id;

-- name: GetMemberRole :one
SELECT role FROM workspace_members WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: ListWorkspacesForUser :many
SELECT sqlc.embed(w), m.role
FROM workspace_members m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.user_id = @user_id
ORDER BY w.created_at, w.id;

-- name: GetWorkspaceMembership :one
SELECT sqlc.embed(w), m.role
FROM workspace_members m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.workspace_id = @workspace_id AND m.user_id = @user_id;

-- name: AddWorkspaceMember :exec
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES (@workspace_id, @user_id, @role);

-- Adds a member, leaving an existing membership untouched. Returns true when a row was inserted.
-- name: AddWorkspaceMemberIfMissing :execrows
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES (@workspace_id, @user_id, @role)
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- name: ListWorkspaceMembers :many
SELECT m.role, m.created_at AS joined_at, u.id AS user_id, u.name, u.email, u.avatar_color
FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = @workspace_id
ORDER BY m.created_at, u.id;

-- name: GetWorkspaceMember :one
SELECT m.role, m.created_at AS joined_at, u.id AS user_id, u.name, u.email, u.avatar_color
FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = @workspace_id AND m.user_id = @user_id;

-- name: UpdateWorkspaceMemberRole :execrows
UPDATE workspace_members SET role = @role WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- name: DeleteWorkspaceMember :execrows
DELETE FROM workspace_members WHERE workspace_id = @workspace_id AND user_id = @user_id;

-- Locks the owner rows of a workspace so the "last owner" check and the change are atomic.
-- name: LockWorkspaceOwners :many
SELECT user_id FROM workspace_members WHERE workspace_id = @workspace_id AND role = 'owner' ORDER BY user_id FOR UPDATE;

-- name: DeleteUserPagePermissionsInWorkspace :exec
DELETE FROM page_permissions g
USING pages p
WHERE g.page_id = p.id AND p.workspace_id = @workspace_id AND g.user_id = @user_id;

-- name: DeleteUserFavoritesInWorkspace :exec
DELETE FROM favorites f
USING pages p
WHERE f.page_id = p.id AND p.workspace_id = @workspace_id AND f.user_id = @user_id;

-- name: CountWorkspaceMembers :one
SELECT count(*) FROM workspace_members WHERE workspace_id = @workspace_id;

-- name: ListWorkspaceIDsForUser :many
SELECT workspace_id FROM workspace_members WHERE user_id = @user_id;

-- ---------------------------------------------------------------- invites
-- name: CreateInvite :one
INSERT INTO invites (token_hash, token, workspace_id, role, email, created_by, expires_at)
VALUES (@token_hash, @token, @workspace_id, @role, sqlc.narg('email'), sqlc.narg('created_by'), @expires_at)
RETURNING *;

-- name: ListPendingInvites :many
SELECT * FROM invites
WHERE workspace_id = @workspace_id AND used_at IS NULL AND expires_at > now()
ORDER BY created_at DESC, id;

-- Valid (unused, unexpired) invite plus the workspace name, looked up by SHA-256 of the token.
-- name: GetValidInviteByTokenHash :one
SELECT sqlc.embed(i), w.name AS workspace_name
FROM invites i
JOIN workspaces w ON w.id = i.workspace_id
WHERE i.token_hash = @token_hash AND i.used_at IS NULL AND i.expires_at > now();

-- Single-use consumption; zero rows means somebody else used it first.
-- name: ConsumeInvite :execrows
UPDATE invites SET used_at = now(), used_by = @used_by
WHERE id = @id AND used_at IS NULL AND expires_at > now();

-- name: DeleteInvite :execrows
DELETE FROM invites WHERE id = @id AND workspace_id = @workspace_id AND used_at IS NULL;

-- name: ListWorkspacePageIDs :many
SELECT id FROM pages WHERE workspace_id = @workspace_id;
