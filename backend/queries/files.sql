-- Files / attachments (conventions §7). Attachment ids are random UUIDv4 (capability-style URLs).

-- name: InsertAttachment :one
INSERT INTO attachments (workspace_id, page_id, uploaded_by, filename, content_type, size_bytes, storage_key)
VALUES (@workspace_id, sqlc.narg('page_id'), sqlc.narg('uploaded_by'), @filename, @content_type, @size_bytes, @storage_key)
RETURNING *;

-- name: GetAttachment :one
SELECT * FROM attachments WHERE id = @id;

-- name: ListAttachmentsByIDs :many
SELECT * FROM attachments WHERE id = ANY(@ids::uuid[]);
