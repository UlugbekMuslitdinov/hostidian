-- GitHub issue sync (docs/github-sync.md).

-- ---------------------------------------------------------------- connections
-- name: InsertGithubConnection :one
INSERT INTO github_connections (workspace_id, owner, repo, token_enc, webhook_secret_enc, sync_user_id)
VALUES (@workspace_id, @owner, @repo, @token_enc, @webhook_secret_enc, @sync_user_id)
RETURNING *;

-- name: GetGithubConnection :one
SELECT * FROM github_connections WHERE id = @id;

-- name: ListGithubConnections :many
SELECT * FROM github_connections WHERE workspace_id = @workspace_id ORDER BY created_at, id;

-- name: ListEnabledGithubConnections :many
SELECT * FROM github_connections WHERE enabled ORDER BY created_at, id;

-- name: UpdateGithubConnection :one
UPDATE github_connections SET
    enabled   = COALESCE(sqlc.narg('enabled')::boolean, enabled),
    token_enc = COALESCE(sqlc.narg('token_enc')::bytea, token_enc),
    sync_user_id = COALESCE(sqlc.narg('sync_user_id')::uuid, sync_user_id)
WHERE id = @id
RETURNING *;

-- name: DeleteGithubConnection :execrows
DELETE FROM github_connections WHERE id = @id;

-- name: SetGithubConnectionRoot :exec
UPDATE github_connections SET root_page_id = @root_page_id WHERE id = @id;

-- name: SetGithubConnectionCursors :exec
UPDATE github_connections SET
    issues_since   = COALESCE(sqlc.narg('issues_since')::timestamptz, issues_since),
    comments_since = COALESCE(sqlc.narg('comments_since')::timestamptz, comments_since)
WHERE id = @id;

-- Forces a full re-import (the root page was purged together with all synced pages).
-- name: ResetGithubConnectionCursors :exec
UPDATE github_connections SET issues_since = NULL, comments_since = NULL, backfilled_at = NULL WHERE id = @id;

-- name: MarkGithubBackfilled :exec
UPDATE github_connections SET backfilled_at = now() WHERE id = @id AND backfilled_at IS NULL;

-- name: RequestGithubSync :exec
UPDATE github_connections SET sync_requested_at = now() WHERE id = @id;

-- Clears the request unless a newer one arrived while the sync ran.
-- name: MarkGithubConnectionSynced :exec
UPDATE github_connections SET
    last_synced_at = now(), last_error = NULL, last_error_at = NULL,
    sync_requested_at = CASE WHEN sync_requested_at <= @started_at::timestamptz THEN NULL ELSE sync_requested_at END
WHERE id = @id;

-- name: SetGithubConnectionError :exec
UPDATE github_connections SET last_error = @last_error, last_error_at = now() WHERE id = @id;

-- ---------------------------------------------------------------- issue links
-- name: InsertGithubIssueLink :one
INSERT INTO github_issue_links (
    page_id, connection_id, issue_number, html_url, base_title, base_state,
    base_local_body_hash, base_remote_body_hash, remote_updated_at, synced_page_updated_at
) VALUES (
    @page_id, @connection_id, @issue_number, @html_url, @base_title, @base_state,
    @base_local_body_hash, @base_remote_body_hash, @remote_updated_at, @synced_page_updated_at
)
RETURNING *;

-- name: GetGithubIssueLinkByNumber :one
SELECT * FROM github_issue_links WHERE connection_id = @connection_id AND issue_number = @issue_number;

-- name: GetGithubIssueLinkByPage :one
SELECT * FROM github_issue_links WHERE page_id = @page_id;

-- Records the outcome of one successful reconcile.
-- name: UpdateGithubIssueLinkSynced :exec
UPDATE github_issue_links SET
    base_title = @base_title, base_state = @base_state,
    base_local_body_hash = @base_local_body_hash, base_remote_body_hash = @base_remote_body_hash,
    remote_updated_at = @remote_updated_at, synced_page_updated_at = @synced_page_updated_at,
    html_url = @html_url, last_synced_at = now(), sync_error = NULL, sync_error_at = NULL
WHERE page_id = @page_id;

-- Closing/reopening from Hostidian: only the state part of the snapshot moves.
-- name: SetGithubIssueLinkState :exec
UPDATE github_issue_links SET base_state = @base_state, remote_updated_at = @remote_updated_at, last_synced_at = now()
WHERE page_id = @page_id;

-- name: SetGithubIssueLinkError :exec
UPDATE github_issue_links SET sync_error = @sync_error, sync_error_at = now() WHERE page_id = @page_id;

-- name: SetGithubIssueLinkThread :exec
UPDATE github_issue_links SET comment_thread_id = @comment_thread_id WHERE page_id = @page_id;

-- Linked, live pages edited since their last sync and quiet for a while (the editor stores content every few seconds).
-- name: ListDirtyGithubLinks :many
SELECT l.* FROM github_issue_links l
JOIN pages p ON p.id = l.page_id
WHERE l.connection_id = @connection_id
  AND p.archived_at IS NULL
  AND p.updated_at > l.synced_page_updated_at
  AND p.updated_at <= @settled_before::timestamptz
ORDER BY p.updated_at, l.page_id
LIMIT @max_rows;

-- Pages created under the connection's root page that have no issue yet.
-- name: ListNewGithubChildPages :many
SELECT p.* FROM pages p
WHERE p.parent_id = @root_page_id
  AND p.archived_at IS NULL
  AND btrim(p.title) <> ''
  AND p.updated_at <= @settled_before::timestamptz
  AND NOT EXISTS (SELECT 1 FROM github_issue_links l WHERE l.page_id = p.id)
ORDER BY p.created_at, p.id
LIMIT @max_rows;

-- name: FindUnlinkedPageForGithubAdoption :one
SELECT p.* FROM pages p
WHERE p.id = @page_id AND p.workspace_id = @workspace_id AND p.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM github_issue_links l WHERE l.page_id = p.id);

-- name: GetGithubLinkDetail :one
SELECT l.*, c.owner, c.repo, c.workspace_id
FROM github_issue_links l
JOIN github_connections c ON c.id = l.connection_id
WHERE l.page_id = @page_id;

-- Every synced page of a workspace (the `[[#123]]` picker index); the caller filters by page permission.
-- name: ListGithubLinksForWorkspace :many
SELECT l.page_id, l.issue_number, l.base_state, l.html_url, c.owner, c.repo
FROM github_issue_links l
JOIN github_connections c ON c.id = l.connection_id
JOIN pages p ON p.id = l.page_id
WHERE c.workspace_id = @workspace_id AND p.archived_at IS NULL
ORDER BY c.owner, c.repo, l.issue_number;

-- page id -> issue number for pages of one connection (rewrites page links to #N on push).
-- name: ListGithubLinkNumbers :many
SELECT page_id, issue_number FROM github_issue_links WHERE connection_id = @connection_id;

-- ---------------------------------------------------------------- comment links
-- name: InsertGithubCommentLink :exec
INSERT INTO github_comment_links (comment_id, connection_id, github_comment_id, origin, remote_updated_at, body_hash)
VALUES (@comment_id, @connection_id, sqlc.narg('github_comment_id'), @origin, sqlc.narg('remote_updated_at'), @body_hash);

-- name: GetGithubCommentLinkByRemote :one
SELECT * FROM github_comment_links WHERE connection_id = @connection_id AND github_comment_id = @github_comment_id;

-- name: GetGithubCommentLinkByComment :one
SELECT * FROM github_comment_links WHERE comment_id = @comment_id;

-- name: UpdateGithubCommentLink :exec
UPDATE github_comment_links SET remote_updated_at = @remote_updated_at, body_hash = @body_hash WHERE comment_id = @comment_id;

-- name: DeleteGithubCommentLinkByRemote :one
DELETE FROM github_comment_links
WHERE connection_id = @connection_id AND github_comment_id = @github_comment_id
RETURNING comment_id, origin;

-- Comments written in Hostidian inside a synced page's GitHub thread that GitHub has not received yet.
-- name: ListUnpushedGithubComments :many
SELECT c.id AS comment_id, c.body, c.author_id, u.name AS author_name, l.page_id, l.issue_number
FROM github_issue_links l
JOIN comments c ON c.thread_id = l.comment_thread_id
JOIN users u ON u.id = c.author_id
JOIN pages p ON p.id = l.page_id
WHERE l.connection_id = @connection_id
  AND p.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM github_comment_links k WHERE k.comment_id = c.id)
ORDER BY c.created_at, c.id
LIMIT @max_rows;

-- Cheap probe the worker runs every tick: is there anything to push?
-- name: HasGithubLocalWork :one
SELECT (
    EXISTS (
        SELECT 1 FROM github_issue_links l JOIN pages p ON p.id = l.page_id
        WHERE l.connection_id = @connection_id AND p.archived_at IS NULL
          AND p.updated_at > l.synced_page_updated_at AND p.updated_at <= @settled_before::timestamptz)
    OR EXISTS (
        SELECT 1 FROM pages p
        WHERE p.parent_id = (SELECT root_page_id FROM github_connections WHERE id = @connection_id)
          AND p.archived_at IS NULL AND btrim(p.title) <> '' AND p.updated_at <= @settled_before::timestamptz
          AND NOT EXISTS (SELECT 1 FROM github_issue_links l WHERE l.page_id = p.id))
    OR EXISTS (
        SELECT 1 FROM github_issue_links l
        JOIN comments c ON c.thread_id = l.comment_thread_id
        JOIN pages p ON p.id = l.page_id
        WHERE l.connection_id = @connection_id AND p.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM github_comment_links k WHERE k.comment_id = c.id))
)::boolean AS has_work;
