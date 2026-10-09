-- name: GetPage :one
SELECT * FROM pages WHERE id = @id;

-- name: GetPageForUpdate :one
SELECT * FROM pages WHERE id = @id FOR UPDATE;

-- name: InsertPage :one
INSERT INTO pages (id, workspace_id, parent_id, title, icon, position, visibility, created_by, last_edited_by)
VALUES (@id, @workspace_id, sqlc.narg('parent_id'), @title, sqlc.narg('icon'), @position, @visibility, @created_by, @created_by)
RETURNING *;

-- ---------------------------------------------------------------- sibling ordering
-- name: LastSiblingPosition :one
SELECT position FROM pages
WHERE workspace_id = @workspace_id
  AND parent_id IS NOT DISTINCT FROM sqlc.narg('parent_id')::uuid
  AND archived_at IS NULL AND id <> @exclude_id
ORDER BY position COLLATE "C" DESC, id DESC
LIMIT 1;

-- Largest sibling position strictly below @pos.
-- name: SiblingPositionBefore :one
SELECT position FROM pages
WHERE workspace_id = @workspace_id
  AND parent_id IS NOT DISTINCT FROM sqlc.narg('parent_id')::uuid
  AND archived_at IS NULL AND id <> @exclude_id
  AND position < @pos::text
ORDER BY position COLLATE "C" DESC, id DESC
LIMIT 1;

-- Smallest sibling position strictly above @pos.
-- name: SiblingPositionAfter :one
SELECT position FROM pages
WHERE workspace_id = @workspace_id
  AND parent_id IS NOT DISTINCT FROM sqlc.narg('parent_id')::uuid
  AND archived_at IS NULL AND id <> @exclude_id
  AND position > @pos::text
ORDER BY position COLLATE "C", id
LIMIT 1;

-- ---------------------------------------------------------------- summaries (role-aware reads)
-- All of these JOIN effective_page_roles(); they return only pages the caller can view.

-- name: GetPageSummary :one
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(
        (SELECT x.workspace_id FROM pages x WHERE x.id = @id), @user_id::uuid,
        COALESCE((SELECT ARRAY[x.id, x.parent_id] FROM pages x WHERE x.id = @id), '{}'::uuid[])) AS r(page_id, role_rank)
)
SELECT sqlc.embed(p), r.role_rank, COALESCE(pr.role_rank >= 1, false)::boolean AS parent_visible
FROM pages p
JOIN roles r ON r.page_id = p.id AND r.role_rank >= 1
LEFT JOIN roles pr ON pr.page_id = p.parent_id
WHERE p.id = @id;

-- name: ListVisiblePages :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT sqlc.embed(p), r.role_rank, (pr.page_id IS NOT NULL)::boolean AS parent_visible
FROM pages p
JOIN roles r ON r.page_id = p.id
LEFT JOIN roles pr ON pr.page_id = p.parent_id
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY p.position COLLATE "C", p.id;

-- name: ListRecentPages :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT sqlc.embed(p), r.role_rank, (pr.page_id IS NOT NULL)::boolean AS parent_visible
FROM pages p
JOIN roles r ON r.page_id = p.id
LEFT JOIN roles pr ON pr.page_id = p.parent_id
WHERE p.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY p.updated_at DESC, p.id
LIMIT @max_rows;

-- name: ListFavoritePages :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
)
SELECT sqlc.embed(p), r.role_rank, (pr.page_id IS NOT NULL)::boolean AS parent_visible
FROM favorites f
JOIN pages p ON p.id = f.page_id
JOIN roles r ON r.page_id = p.id
LEFT JOIN roles pr ON pr.page_id = p.parent_id
WHERE f.user_id = @user_id AND p.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY f.created_at DESC, p.id;

-- Archived subtree roots on which the caller has `full`.
-- name: ListTrash :many
WITH roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 4
)
SELECT sqlc.embed(p), r.role_rank, false::boolean AS parent_visible
FROM pages p
JOIN roles r ON r.page_id = p.id
LEFT JOIN pages par ON par.id = p.parent_id
WHERE p.workspace_id = @workspace_id
  AND p.archived_at IS NOT NULL
  AND (par.id IS NULL OR par.archived_at IS DISTINCT FROM p.archived_at)
ORDER BY p.archived_at DESC, p.id;

-- Ancestors (root first) of a page that the caller can view.
-- name: ListVisibleAncestors :many
WITH RECURSIVE chain AS (
    SELECT p.id, p.parent_id, 1 AS depth
    FROM pages p WHERE p.id = (SELECT x.parent_id FROM pages x WHERE x.id = @page_id)
    UNION ALL
    SELECT p.id, p.parent_id, chain.depth + 1
    FROM pages p JOIN chain ON p.id = chain.parent_id
),
roles AS (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(
        (SELECT workspace_id FROM pages WHERE id = @page_id), @user_id::uuid,
        COALESCE((SELECT array_agg(id) FROM chain), '{}'::uuid[])) AS r(page_id, role_rank)
)
SELECT p.id, p.title, p.icon
FROM chain
JOIN pages p ON p.id = chain.id
JOIN roles r ON r.page_id = p.id AND r.role_rank >= 1
ORDER BY chain.depth DESC;

-- ---------------------------------------------------------------- mutation helpers
-- name: UpdatePageMeta :one
UPDATE pages SET
    title          = COALESCE(sqlc.narg('title'), title),
    icon           = CASE WHEN @set_icon::boolean THEN sqlc.narg('icon') ELSE icon END,
    cover          = CASE WHEN @set_cover::boolean THEN sqlc.narg('cover') ELSE cover END,
    last_edited_by = @editor_id,
    updated_at     = now()
WHERE id = @id
RETURNING *;

-- name: MovePage :one
UPDATE pages SET parent_id = sqlc.narg('parent_id'), position = @position, visibility = @visibility, updated_at = now()
WHERE id = @id
RETURNING *;

-- name: SetPageVisibility :one
UPDATE pages SET visibility = @visibility, updated_at = now() WHERE id = @id RETURNING *;

-- name: ListSubtreeIDs :many
WITH RECURSIVE sub AS (
    SELECT p0.id FROM pages p0 WHERE p0.id = @id
    UNION ALL
    SELECT c.id FROM pages c JOIN sub ON c.parent_id = sub.id
)
SELECT sub.id FROM sub;

-- True when @candidate_id is @id itself or one of its descendants (used for cycle detection).
-- name: IsInSubtree :one
WITH RECURSIVE sub AS (
    SELECT p0.id FROM pages p0 WHERE p0.id = @id
    UNION ALL
    SELECT c.id FROM pages c JOIN sub ON c.parent_id = sub.id
)
SELECT (count(*) > 0)::boolean FROM sub WHERE id = @candidate_id::uuid;

-- The root page (parent_id IS NULL) of the tree that contains @page_id.
-- name: GetRootPage :one
WITH RECURSIVE chain AS (
    SELECT p0.* FROM pages p0 WHERE p0.id = @page_id
    UNION ALL
    SELECT p.* FROM pages p JOIN chain ON p.id = chain.parent_id
)
SELECT chain.id, chain.visibility, chain.created_by FROM chain WHERE chain.parent_id IS NULL;

-- Archives the not-yet-archived part of a subtree with one shared timestamp (now() is the
-- transaction timestamp, identical for every row of the statement). Returns the archived ids.
-- name: ArchiveSubtree :many
WITH RECURSIVE sub AS (
    SELECT p0.id FROM pages p0 WHERE p0.id = @id
    UNION ALL
    SELECT c.id FROM pages c JOIN sub ON c.parent_id = sub.id
)
UPDATE pages SET archived_at = now(), updated_at = now()
WHERE pages.id IN (SELECT sub.id FROM sub) AND pages.archived_at IS NULL
RETURNING id;

-- Un-archives exactly the rows of the subtree that carry the same archived_at as the target.
-- name: RestoreSubtree :many
WITH RECURSIVE sub AS (
    SELECT p0.id FROM pages p0 WHERE p0.id = @id
    UNION ALL
    SELECT c.id FROM pages c JOIN sub ON c.parent_id = sub.id WHERE c.archived_at = @archived_at
)
UPDATE pages SET archived_at = NULL, updated_at = now()
WHERE pages.id IN (SELECT sub.id FROM sub) AND pages.archived_at = @archived_at
RETURNING id;

-- name: DeletePage :execrows
DELETE FROM pages WHERE id = @id;

-- ---------------------------------------------------------------- favorites
-- name: AddFavorite :exec
INSERT INTO favorites (user_id, page_id) VALUES (@user_id, @page_id) ON CONFLICT DO NOTHING;

-- name: RemoveFavorite :exec
DELETE FROM favorites WHERE user_id = @user_id AND page_id = @page_id;

-- name: IsFavorite :one
SELECT EXISTS (SELECT 1 FROM favorites WHERE user_id = @user_id AND page_id = @page_id)::boolean;

-- ---------------------------------------------------------------- duplicate
-- Page ids of the subtree of @root_id that the caller can view (invisible nodes prune their subtree).
-- Parents come before children.
-- name: ListVisibleSubtree :many
WITH RECURSIVE roles AS MATERIALIZED (
    SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
    FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank)
    WHERE r.role_rank >= 1
),
sub AS (
    SELECT p.id, 0 AS depth FROM pages p JOIN roles r ON r.page_id = p.id WHERE p.id = @root_id
    UNION ALL
    SELECT c.id, sub.depth + 1
    FROM pages c
    JOIN sub ON c.parent_id = sub.id
    JOIN roles r ON r.page_id = c.id
    WHERE c.archived_at IS NULL
)
SELECT sub.id FROM sub ORDER BY sub.depth, sub.id;

-- Copies pages old_ids[i] -> new_ids[i]. Children are re-parented through the mapping; the page
-- whose id is @root_old_id becomes a child of @root_parent_id with @root_position/@root_title/@root_visibility.
-- name: CopyPages :exec
WITH m AS (
    SELECT o.old_id::uuid AS old_id, nw.new_id::uuid AS new_id
    FROM unnest(@old_ids::uuid[]) WITH ORDINALITY AS o(old_id, n)
    JOIN unnest(@new_ids::uuid[]) WITH ORDINALITY AS nw(new_id, n) ON o.n = nw.n
)
INSERT INTO pages (id, workspace_id, parent_id, title, icon, cover, position, visibility, created_by, last_edited_by)
SELECT m.new_id,
       p.workspace_id,
       CASE WHEN p.id = @root_old_id::uuid THEN sqlc.narg('root_parent_id')::uuid ELSE pm.new_id END,
       CASE WHEN p.id = @root_old_id::uuid THEN @root_title::text ELSE p.title END,
       p.icon,
       p.cover,
       CASE WHEN p.id = @root_old_id::uuid THEN @root_position::text ELSE p.position END,
       CASE WHEN p.id = @root_old_id::uuid THEN @root_visibility::text ELSE 'workspace' END,
       @actor_id::uuid,
       @actor_id::uuid
FROM m
JOIN pages p ON p.id = m.old_id
LEFT JOIN m pm ON pm.old_id = p.parent_id;

-- name: CopyPageDocuments :exec
WITH m AS (
    SELECT o.old_id::uuid AS old_id, nw.new_id::uuid AS new_id
    FROM unnest(@old_ids::uuid[]) WITH ORDINALITY AS o(old_id, n)
    JOIN unnest(@new_ids::uuid[]) WITH ORDINALITY AS nw(new_id, n) ON o.n = nw.n
)
INSERT INTO page_documents (page_id, ydoc)
SELECT m.new_id, d.ydoc
FROM m
JOIN page_documents d ON d.page_id = m.old_id;

-- name: CopyPageContent :exec
WITH m AS (
    SELECT o.old_id::uuid AS old_id, nw.new_id::uuid AS new_id
    FROM unnest(@old_ids::uuid[]) WITH ORDINALITY AS o(old_id, n)
    JOIN unnest(@new_ids::uuid[]) WITH ORDINALITY AS nw(new_id, n) ON o.n = nw.n
)
INSERT INTO page_content (page_id, markdown, plaintext, blocks)
SELECT m.new_id, c.markdown, c.plaintext, c.blocks
FROM m
JOIN page_content c ON c.page_id = m.old_id;

-- Links of the copies point at the same targets as the originals (the copied Y.Doc still references them).
-- name: CopyPageLinks :exec
WITH m AS (
    SELECT o.old_id::uuid AS old_id, nw.new_id::uuid AS new_id
    FROM unnest(@old_ids::uuid[]) WITH ORDINALITY AS o(old_id, n)
    JOIN unnest(@new_ids::uuid[]) WITH ORDINALITY AS nw(new_id, n) ON o.n = nw.n
)
INSERT INTO page_links (source_page_id, target_page_id)
SELECT m.new_id, l.target_page_id
FROM m
JOIN page_links l ON l.source_page_id = m.old_id;

-- ---------------------------------------------------------------- permissions
-- Nearest explicit grant per user on the page or an ancestor, with the page it is attached to.
-- name: ListEffectiveGrants :many
WITH RECURSIVE chain AS (
    SELECT p0.id, p0.parent_id, 0 AS depth FROM pages p0 WHERE p0.id = @page_id
    UNION ALL
    SELECT p.id, p.parent_id, chain.depth + 1 FROM pages p JOIN chain ON p.id = chain.parent_id
)
SELECT DISTINCT ON (g.user_id)
       g.user_id, g.role, g.page_id AS granted_on, u.name, u.email, u.avatar_color
FROM chain
JOIN page_permissions g ON g.page_id = chain.id
JOIN users u ON u.id = g.user_id
ORDER BY g.user_id, chain.depth;

-- name: UpsertPagePermission :exec
INSERT INTO page_permissions (page_id, user_id, role, granted_by)
VALUES (@page_id, @user_id, @role, sqlc.narg('granted_by'))
ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by;

-- name: DeletePagePermission :execrows
DELETE FROM page_permissions WHERE page_id = @page_id AND user_id = @user_id;

-- name: GetPagesByIDs :many
SELECT * FROM pages WHERE id = ANY(@ids::uuid[]) ORDER BY position COLLATE "C", id;

-- Serializes tree-shape changes (moves) inside a workspace so two concurrent moves cannot each pass
-- the cycle check and then create a loop together.
-- name: LockWorkspaceTree :exec
SELECT pg_advisory_xact_lock(hashtext('hostidian:tree:' || @workspace_id::text));
