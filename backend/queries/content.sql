-- Derived page content, links and the permission-filtered read models for search, backlinks and the
-- graph (conventions §8/§9). Everything that lists pages JOINs effective_page_roles().

-- ---------------------------------------------------------------- content ingestion (internal)
-- name: GetPageContent :one
SELECT * FROM page_content WHERE page_id = @page_id;

-- name: UpsertPageContent :exec
INSERT INTO page_content (page_id, markdown, plaintext, blocks, updated_at)
VALUES (@page_id, @markdown, @plaintext, @blocks, now())
ON CONFLICT (page_id) DO UPDATE SET
    markdown   = EXCLUDED.markdown,
    plaintext  = EXCLUDED.plaintext,
    blocks     = EXCLUDED.blocks,
    updated_at = now();

-- name: DeletePageLinks :exec
DELETE FROM page_links WHERE source_page_id = @source_page_id;

-- Keeps only targets that exist in the source page's workspace and are not the source itself.
-- name: InsertPageLinks :exec
INSERT INTO page_links (source_page_id, target_page_id)
SELECT @source_page_id, t
FROM unnest(@targets::uuid[]) AS t
JOIN pages p ON p.id = t
WHERE p.workspace_id = (SELECT workspace_id FROM pages WHERE id = @source_page_id)
  AND t <> @source_page_id
ON CONFLICT DO NOTHING;

-- name: TouchPageEdited :exec
UPDATE pages SET updated_at = now(), last_edited_by = COALESCE(sqlc.narg('editor_id'), last_edited_by)
WHERE id = @id;

-- ---------------------------------------------------------------- backlinks / graph
-- name: ListBacklinks :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT p.id, p.title, p.icon
FROM page_links l
JOIN pages p ON p.id = l.source_page_id
JOIN roles r ON r.page_id = p.id
WHERE l.target_page_id = @target_page_id AND p.archived_at IS NULL
ORDER BY p.updated_at DESC, p.id;

-- name: ListGraphNodes :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT p.id, p.title, p.icon, p.parent_id,
       (SELECT count(*) FROM page_links pl WHERE pl.source_page_id = p.id)::int AS link_count
FROM pages p
JOIN roles r ON r.page_id = p.id
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY p.position COLLATE "C", p.id;

-- Edges only between two visible, non-archived pages.
-- name: ListGraphEdges :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT l.source_page_id AS source, l.target_page_id AS target
FROM page_links l
JOIN roles rs ON rs.page_id = l.source_page_id
JOIN roles rt ON rt.page_id = l.target_page_id
JOIN pages ps ON ps.id = l.source_page_id AND ps.archived_at IS NULL
JOIN pages pt ON pt.id = l.target_page_id AND pt.archived_at IS NULL
WHERE ps.workspace_id = @workspace_id
ORDER BY l.source_page_id, l.target_page_id;

-- ---------------------------------------------------------------- search (conventions §9)
-- Body + title full-text search. @tsquery is a safe prefix tsquery built from the user input.
-- name: SearchPagesFull :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT sqlc.embed(p), r.role_rank, (pr.page_id IS NOT NULL)::boolean AS parent_visible,
       (ts_rank_cd(p.title_tsv, q.query, 32) + COALESCE(ts_rank_cd(pc.body_tsv, q.query, 32), 0))::float8 AS rank,
       ts_headline('simple', COALESCE(NULLIF(pc.plaintext, ''), p.title), q.query,
                   'MaxFragments=2,MaxWords=20,MinWords=5') AS snippet
FROM pages p
JOIN roles r ON r.page_id = p.id
LEFT JOIN roles pr ON pr.page_id = p.parent_id
LEFT JOIN page_content pc ON pc.page_id = p.id
CROSS JOIN (SELECT to_tsquery('simple', @tsquery::text) AS query) q
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
  AND (p.title_tsv @@ q.query OR pc.body_tsv @@ q.query)
ORDER BY rank DESC, p.updated_at DESC, p.id
LIMIT @max_rows;

-- Fuzzy title search for the quick switcher.
-- name: SearchPagesTitle :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT sqlc.embed(p), r.role_rank, (pr.page_id IS NOT NULL)::boolean AS parent_visible,
       similarity(p.title, @query::text)::float8 AS rank,
       NULL::text AS snippet
FROM pages p
JOIN roles r ON r.page_id = p.id
LEFT JOIN roles pr ON pr.page_id = p.parent_id
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
  AND (p.title % @query::text OR position(lower(@query::text) in lower(p.title)) > 0)
ORDER BY rank DESC, p.updated_at DESC, p.id
LIMIT @max_rows;
