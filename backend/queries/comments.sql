-- Comments (conventions §10): block-anchored threads stored only in Postgres.

-- name: InsertCommentThread :one
INSERT INTO comment_threads (page_id, block_id, quote, created_by)
VALUES (@page_id, @block_id, @quote, @created_by)
RETURNING *;

-- name: GetCommentThread :one
SELECT * FROM comment_threads WHERE id = @id;

-- name: ListCommentThreads :many
SELECT * FROM comment_threads
WHERE page_id = @page_id AND (@include_resolved::boolean OR resolved_at IS NULL)
ORDER BY created_at, id;

-- name: InsertComment :one
INSERT INTO comments (thread_id, author_id, body)
VALUES (@thread_id, @author_id, @body)
RETURNING *;

-- name: GetComment :one
SELECT * FROM comments WHERE id = @id;

-- name: UpdateComment :one
UPDATE comments SET body = @body, updated_at = now() WHERE id = @id RETURNING *;

-- name: DeleteComment :execrows
DELETE FROM comments WHERE id = @id;

-- Comments (with author) of a set of threads.
-- name: ListThreadComments :many
SELECT c.id, c.thread_id, c.author_id, c.body, c.created_at, c.updated_at, u.name, u.avatar_color
FROM comments c
JOIN users u ON u.id = c.author_id
WHERE c.thread_id = ANY(@thread_ids::uuid[])
ORDER BY c.created_at, c.id;

-- name: ResolveCommentThread :one
UPDATE comment_threads SET resolved_at = now(), resolved_by = @resolved_by
WHERE id = @id AND resolved_at IS NULL
RETURNING *;

-- name: ReopenCommentThread :one
UPDATE comment_threads SET resolved_at = NULL, resolved_by = NULL
WHERE id = @id
RETURNING *;

-- Deletes the thread only when it has no comments left (used after deleting the last comment).
-- name: DeleteEmptyCommentThread :execrows
DELETE FROM comment_threads t
WHERE t.id = @id AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = t.id);
