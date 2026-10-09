-- Public share links (conventions §11).

-- name: InsertShareLink :one
INSERT INTO share_links (page_id, token, include_subpages, created_by)
VALUES (@page_id, @token, @include_subpages, sqlc.narg('created_by'))
RETURNING *;

-- name: ListShareLinks :many
SELECT * FROM share_links
WHERE page_id = @page_id AND revoked_at IS NULL
ORDER BY created_at, id;

-- name: GetShareLink :one
SELECT * FROM share_links WHERE id = @id;

-- name: GetShareLinkByToken :one
SELECT * FROM share_links WHERE token = @token AND revoked_at IS NULL;

-- name: UpdateShareLink :one
UPDATE share_links SET include_subpages = @include_subpages WHERE id = @id RETURNING *;

-- name: RevokeShareLink :execrows
UPDATE share_links SET revoked_at = now() WHERE id = @id AND revoked_at IS NULL;

-- True when @page_id is @root_page_id itself or one of its descendants is provided by the existing
-- IsInSubtree query in pages.sql (IsInSubtree(ID=root, CandidateID=page)).

-- Non-archived subtree (flat, ordered) for a public page tree view.
-- name: ListPublicSubtree :many
WITH RECURSIVE sub AS (
    SELECT p.id, p.parent_id, p.title, p.icon, p.cover, p.position, 0 AS depth
    FROM pages p WHERE p.id = @root_page_id
    UNION ALL
    SELECT c.id, c.parent_id, c.title, c.icon, c.cover, c.position, sub.depth + 1
    FROM pages c JOIN sub ON c.parent_id = sub.id
    WHERE c.archived_at IS NULL
)
SELECT sub.id, sub.parent_id, sub.title, sub.icon, sub.cover
FROM sub
ORDER BY sub.depth, sub.position COLLATE "C", sub.id;

-- Public page metadata + extracted blocks for one page of a shared subtree.
-- name: GetPublicPageData :one
SELECT p.id, p.parent_id, p.title, p.icon, p.cover,
       COALESCE(pc.blocks, '[]'::jsonb)::jsonb AS blocks,
       COALESCE(pc.updated_at, p.updated_at)::timestamptz AS content_updated_at
FROM pages p
LEFT JOIN page_content pc ON pc.page_id = p.id
WHERE p.id = @page_id AND p.archived_at IS NULL;
