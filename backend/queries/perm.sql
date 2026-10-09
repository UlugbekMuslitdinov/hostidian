-- The permission resolver lives in SQL (migrations/00002_perm_functions.sql); these queries are the
-- only Go entry points into it from internal/perm. Everything else that needs "what can this user
-- see" JOINs effective_page_roles() itself (see pages.sql).
--
-- Reminder: pass COALESCE(array_agg(..), '{}') as the page-id array, never NULL (NULL = every page).

-- Role of a user on one page plus whether the page's parent is visible to them.
-- name: ResolvePageAccess :one
SELECT p.id, p.workspace_id, p.parent_id, p.archived_at,
       COALESCE((SELECT r.role_rank FROM effective_page_roles(p.workspace_id, @user_id::uuid, ARRAY[p.id, p.parent_id]) AS r(page_id, role_rank)
                 WHERE r.page_id = p.id), 0)::int AS role_rank,
       COALESCE((SELECT r.role_rank >= 1 FROM effective_page_roles(p.workspace_id, @user_id::uuid, ARRAY[p.id, p.parent_id]) AS r(page_id, role_rank)
                 WHERE r.page_id = p.parent_id), false)::boolean AS parent_visible
FROM pages p
WHERE p.id = @page_id;

-- Roles for a set of pages of one workspace (used for batch checks).
-- name: ResolvePageRoles :many
SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid, @page_ids::uuid[]) AS r(page_id, role_rank);

-- Every page of the workspace with the caller's rank (including rank 0).
-- name: ResolveWorkspaceRoles :many
SELECT r.page_id::uuid AS page_id, r.role_rank::int AS role_rank
FROM effective_page_roles(@workspace_id::uuid, @user_id::uuid) AS r(page_id, role_rank);
