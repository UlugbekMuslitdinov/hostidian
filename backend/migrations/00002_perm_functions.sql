-- +goose Up
-- +goose StatementBegin

-- The permission resolver (docs/conventions.md §3), defined once as set-based SQL.
-- Every endpoint, search, graph, backlinks and SSE filtering goes through effective_page_roles();
-- Go reaches it through backend/internal/perm.

-- Role rank: 0 none, 1 view, 2 comment, 3 edit, 4 full.
CREATE FUNCTION page_role_rank(role text) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT CASE role
        WHEN 'full'    THEN 4
        WHEN 'edit'    THEN 3
        WHEN 'comment' THEN 2
        WHEN 'view'    THEN 1
        ELSE 0
    END
$$;

-- +goose StatementEnd
-- +goose StatementBegin

-- Effective role rank of p_user for the pages of p_workspace. Archived pages are included (callers
-- filter on pages.archived_at); pages without access come back with rank 0, so callers must
-- filter on role_rank >= 1 where they mean "visible".
--
-- Rank = max(base, nearest grant on the page or any ancestor), where
--   base = 4 (full) for workspace owners/admins,
--          3 (edit) for members on workspace-visibility roots,
--          4 (full) for the creator of a private root,
--          0 otherwise (guests, other members on private roots),
-- and a "grant" on a page is its explicit page_permissions row for the user, or an implicit `full`
-- for the user in pages.created_by (creator ownership, conventions §3). On one page the two combine
-- by max, i.e. the creator is always full there. The nearest page that carries a grant for the
-- user decides, so an explicit grant on a descendant overrides the inherited implicit one; the
-- result never drops below base.
-- Non-members of the workspace get no rows at all.
--
-- p_page_ids restricts the result to those pages. Only their ancestors are walked, so a
-- single-page check is O(depth) instead of O(workspace). Pass an empty array, never NULL, when
-- "no pages" is meant: NULL selects every page of the workspace.
--
-- SET jit = off: the planner's cost estimate for the recursive CTE is huge, which makes Postgres
-- JIT-compile the plan (~200 ms) even when it touches a handful of rows (measured: 226 ms -> 2 ms).
CREATE FUNCTION effective_page_roles(p_workspace uuid, p_user uuid, p_page_ids uuid[] DEFAULT NULL)
RETURNS TABLE (page_id uuid, role_rank int)
LANGUAGE sql STABLE
SET jit = off
AS $$
WITH RECURSIVE
member AS (
    SELECT wm.role FROM workspace_members wm
    WHERE wm.workspace_id = p_workspace AND wm.user_id = p_user
),
-- ancestors-or-self of the requested pages (empty unless p_page_ids is given)
closure AS (
    SELECT p.id, p.parent_id FROM pages p
    WHERE p.workspace_id = p_workspace AND p.id = ANY(p_page_ids)
    UNION
    SELECT a.id, a.parent_id FROM pages a JOIN closure c ON a.id = c.parent_id
    WHERE a.workspace_id = p_workspace
),
nodes AS (
    SELECT p.id, p.parent_id, p.visibility, p.created_by FROM pages p
    WHERE p.workspace_id = p_workspace AND p_page_ids IS NULL
    UNION ALL
    SELECT p.id, p.parent_id, p.visibility, p.created_by FROM pages p
    JOIN closure c ON c.id = p.id
    WHERE p_page_ids IS NOT NULL
),
tree AS (
    SELECT n.id,
           CASE
               WHEN m.role IN ('owner', 'admin') THEN 4
               WHEN n.visibility = 'private' THEN CASE WHEN n.created_by = p_user THEN 4 ELSE 0 END
               WHEN m.role = 'member' THEN 3
               ELSE 0
           END AS base,
           COALESCE(CASE WHEN n.created_by = p_user THEN 4
                         ELSE (SELECT page_role_rank(g.role) FROM page_permissions g
                               WHERE g.page_id = n.id AND g.user_id = p_user) END, 0) AS grant_rank
    FROM nodes n
    CROSS JOIN member m
    WHERE n.parent_id IS NULL
    UNION ALL
    SELECT c.id,
           t.base,
           COALESCE(CASE WHEN c.created_by = p_user THEN 4
                         ELSE (SELECT page_role_rank(g.role) FROM page_permissions g
                               WHERE g.page_id = c.id AND g.user_id = p_user) END, t.grant_rank)
    FROM nodes c
    JOIN tree t ON c.parent_id = t.id
)
SELECT t.id, GREATEST(t.base, t.grant_rank)
FROM tree t
WHERE p_page_ids IS NULL OR t.id = ANY(p_page_ids)
$$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS effective_page_roles(uuid, uuid, uuid[]);
DROP FUNCTION IF EXISTS page_role_rank(text);
-- +goose StatementEnd
