-- Files / attachments (conventions §7). Attachment ids are random UUIDv4 (capability-style URLs).

-- name: InsertAttachment :one
INSERT INTO attachments (id, workspace_id, page_id, uploaded_by, filename, content_type, size_bytes, storage_key)
VALUES (@id, @workspace_id, sqlc.narg('page_id'), sqlc.narg('uploaded_by'), @filename, @content_type, @size_bytes, @storage_key)
RETURNING *;

-- name: GetAttachment :one
SELECT * FROM attachments WHERE id = @id;

-- name: ListAttachmentsByIDs :many
SELECT * FROM attachments WHERE id = ANY(@ids::uuid[]);

-- name: ListUnreferencedAttachments :many
-- Attachments no page references any more (neither in its markdown, its lossless block JSON, nor as a cover).
SELECT a.id, a.storage_key
FROM attachments a
WHERE a.created_at < now() - make_interval(secs => @min_age_seconds::double precision)
  AND NOT EXISTS (
        SELECT 1 FROM page_content pc JOIN pages p ON p.id = pc.page_id
        WHERE p.workspace_id = a.workspace_id
          AND (position(a.id::text IN pc.markdown) > 0 OR position(a.id::text IN pc.blocks::text) > 0))
  AND NOT EXISTS (
        SELECT 1 FROM pages p
        WHERE p.workspace_id = a.workspace_id AND p.cover = '/api/files/' || a.id::text)
ORDER BY a.created_at
LIMIT @batch::int;

-- name: DeleteAttachmentsByIDs :exec
DELETE FROM attachments WHERE id = ANY(@ids::uuid[]);
