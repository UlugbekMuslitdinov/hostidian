-- name: GetInstanceSettings :one
SELECT * FROM instance_settings WHERE id;

-- name: UpdateInstanceSettings :one
UPDATE instance_settings SET
    instance_name            = COALESCE(sqlc.narg('instance_name'), instance_name),
    allow_open_signup        = COALESCE(sqlc.narg('allow_open_signup'), allow_open_signup),
    allow_workspace_creation = COALESCE(sqlc.narg('allow_workspace_creation'), allow_workspace_creation),
    updated_at               = now()
WHERE id
RETURNING *;

-- name: CountUsers :one
SELECT count(*) FROM users;

-- Serializes first-run setup so two concurrent POST /setup cannot both create an admin.
-- name: LockSetup :exec
SELECT pg_advisory_xact_lock(hashtext('hostidian:setup'));
