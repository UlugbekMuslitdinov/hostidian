-- Import / export (conventions §8) and the async import job queue.

-- name: InsertImportJob :one
INSERT INTO import_jobs (workspace_id, user_id, parent_page_id, status, total, upload_path)
VALUES (@workspace_id, @user_id, sqlc.narg('parent_page_id'), 'pending', @total, @upload_path)
RETURNING *;

-- name: GetImportJob :one
SELECT * FROM import_jobs WHERE id = @id;

-- name: MarkImportJobRunning :exec
UPDATE import_jobs SET status = 'running' WHERE id = @id;

-- name: FinishImportJob :one
UPDATE import_jobs
SET status = @status,
    total = @total,
    processed = @processed,
    error = sqlc.narg('error'),
    result = sqlc.narg('result'),
    finished_at = now()
WHERE id = @id
RETURNING *;

-- name: UpdateImportJobProgress :exec
UPDATE import_jobs SET total = @total, processed = @processed WHERE id = @id;

-- Pages of a subtree the caller can view, with their extracted markdown (parents first).
-- name: ListSubtreeForExport :many
WITH RECURSIVE roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
),
sub AS (
    SELECT p.id, 0 AS depth FROM pages p JOIN roles r ON r.page_id = p.id WHERE p.id = @root_id
    UNION ALL
    SELECT c.id, sub.depth + 1
    FROM pages c JOIN sub ON c.parent_id = sub.id JOIN roles r ON r.page_id = c.id
    WHERE c.archived_at IS NULL
)
SELECT sqlc.embed(p), COALESCE(pc.markdown, '')::text AS markdown
FROM sub
JOIN pages p ON p.id = sub.id
LEFT JOIN page_content pc ON pc.page_id = p.id
WHERE p.archived_at IS NULL
ORDER BY sub.depth, p.position COLLATE "C", p.id;

-- Every non-archived page the caller can view in the workspace, with extracted markdown.
-- name: ListWorkspaceForExport :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT sqlc.embed(p), COALESCE(pc.markdown, '')::text AS markdown
FROM pages p
JOIN roles r ON r.page_id = p.id
LEFT JOIN page_content pc ON pc.page_id = p.id
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY p.position COLLATE "C", p.id;
