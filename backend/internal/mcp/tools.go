package mcp

import (
	"context"
	"html"
	"strings"
	"time"

	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/comments"
	"hostidian/backend/internal/content"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/pages"
	"hostidian/backend/internal/perm"
)

// ---------------------------------------------------------------- shapes returned to agents

type pageRef struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
	Icon  *string   `json:"icon,omitempty"`
}

type pageItem struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parentId"`
	Title     string     `json:"title"`
	Icon      *string    `json:"icon,omitempty"`
	Role      string     `json:"role"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

func itemOf(p gen.PageSummary) pageItem {
	item := pageItem{ID: p.Id, Title: p.Title, Icon: p.Icon, Role: string(p.Role), UpdatedAt: p.UpdatedAt}
	if p.ParentId != nil {
		id := uuid.UUID(*p.ParentId)
		item.ParentID = &id
	}
	return item
}

// ---------------------------------------------------------------- inputs

type listWorkspacesIn struct{}

type searchPagesIn struct {
	WorkspaceID string `json:"workspace_id" jsonschema:"Workspace to search (from list_workspaces)."`
	Query       string `json:"query" jsonschema:"Words to look for, at most 200 characters."`
	Mode        string `json:"mode,omitempty" jsonschema:"full (default): titles and page text, with snippets. title: fuzzy match on titles only."`
	Limit       int    `json:"limit,omitempty" jsonschema:"Maximum results, 1 to 50 (default 20)."`
}

type listPagesIn struct {
	WorkspaceID string `json:"workspace_id" jsonschema:"Workspace to list (from list_workspaces)."`
	ParentID    string `json:"parent_id,omitempty" jsonschema:"Only list the pages below this page. Omit to list the whole workspace."`
}

type pageIDIn struct {
	PageID string `json:"page_id" jsonschema:"The page id (UUID)."`
}

type listCommentsIn struct {
	PageID          string `json:"page_id" jsonschema:"The page id (UUID)."`
	IncludeResolved bool   `json:"include_resolved,omitempty" jsonschema:"Also return resolved threads (default false)."`
}

type createPageIn struct {
	WorkspaceID string `json:"workspace_id" jsonschema:"Workspace to create the page in (from list_workspaces)."`
	Title       string `json:"title" jsonschema:"Page title, at most 500 characters."`
	ParentID    string `json:"parent_id,omitempty" jsonschema:"Create the page below this page. Omit for a top-level page."`
	Icon        string `json:"icon,omitempty" jsonschema:"An emoji used as the page icon."`
	Markdown    string `json:"markdown,omitempty" jsonschema:"Initial page body as Markdown (at most 1 MB)."`
}

type updatePageIn struct {
	PageID string  `json:"page_id" jsonschema:"The page id (UUID)."`
	Title  *string `json:"title,omitempty" jsonschema:"New title. Omit to keep the current one."`
	Icon   *string `json:"icon,omitempty" jsonschema:"New emoji icon; an empty string removes the icon. Omit to keep the current one."`
}

type editContentIn struct {
	PageID   string `json:"page_id" jsonschema:"The page id (UUID)."`
	Mode     string `json:"mode" jsonschema:"replace: overwrite the whole body. append: add at the end. prepend: add at the start."`
	Markdown string `json:"markdown" jsonschema:"The Markdown to apply (at most 1 MB)."`
}

type movePageIn struct {
	PageID   string `json:"page_id" jsonschema:"The page to move."`
	ParentID string `json:"parent_id,omitempty" jsonschema:"New parent page. Omit to move the page to the top level."`
	AfterID  string `json:"after_id,omitempty" jsonschema:"Place the page right after this sibling. Omit to put it last."`
}

type addCommentIn struct {
	PageID   string `json:"page_id" jsonschema:"The page id (UUID)."`
	Body     string `json:"body" jsonschema:"The comment text (plain text, at most 10000 characters)."`
	BlockID  string `json:"block_id,omitempty" jsonschema:"Block of the page to attach a new thread to (ids appear in list_comments). Defaults to the first block."`
	ThreadID string `json:"thread_id,omitempty" jsonschema:"Reply to this existing thread instead of starting a new one."`
}

// ---------------------------------------------------------------- registration

func (s *Server) registerTools(srv *sdk.Server) {
	addTool(s, srv, toolDef{
		name: "list_workspaces", title: "List workspaces",
		description: "List the workspaces this token can access, with your role in each. Start here to get workspace ids.",
	}, s.listWorkspaces)

	addTool(s, srv, toolDef{
		name: "search_pages", title: "Search pages",
		description: "Search the pages of a workspace by title and text (up to 50 results, ranked). Result snippets mark matches with ** **. Search reads stored page content, which can lag live typing by up to ~10 seconds." + dataWarning,
	}, s.searchPages)

	addTool(s, srv, toolDef{
		name: "list_pages", title: "List pages",
		description: "List pages as a flat list with parent ids (at most 500, in tree order within each parent), for the whole workspace or below one page." + dataWarning,
	}, s.listPages)

	addTool(s, srv, toolDef{
		name: "get_page", title: "Read a page",
		description: "Read a page: title, icon, your role, breadcrumbs and the body as Markdown (links to other pages look like [[hostidian:<page_id>|Title]]). The Markdown is the last stored version and can lag live typing by up to ~10 seconds; very long pages are truncated at 1 MB and say so." + dataWarning,
	}, s.getPage)

	addTool(s, srv, toolDef{
		name: "get_backlinks", title: "List backlinks",
		description: "List the pages that link to a page (only pages you can see)." + dataWarning,
	}, s.getBacklinks)

	addTool(s, srv, toolDef{
		name: "list_comments", title: "List comments",
		description: "List the comment threads of a page with their comments." + dataWarning,
	}, s.listComments)

	addTool(s, srv, toolDef{
		name: "create_page", title: "Create a page", write: true,
		description: "Create a page, optionally with an initial Markdown body. Use [[hostidian:<page_id>|Title]] to link to other pages and /api/files/<id> for attachments. People who have the parent open see the new page appear.",
	}, s.createPage)

	addTool(s, srv, toolDef{
		name: "update_page", title: "Rename a page", write: true, destructive: true, idempotent: true,
		description: "Change a page's title and/or icon. The body is edited with edit_page_content.",
	}, s.updatePage)

	addTool(s, srv, toolDef{
		name: "edit_page_content", title: "Edit page content", write: true, destructive: true,
		description: "Edit the body of a page with Markdown: mode replace overwrites the whole body (unchanged blocks keep their identity), append adds at the end, prepend adds at the start. The change goes through the live document, so people with the page open see it immediately and their own concurrent edits are kept. Returns the resulting Markdown. Prefer append/prepend over replace unless you really mean to rewrite the page." + dataWarning,
	}, s.editPageContent)

	addTool(s, srv, toolDef{
		name: "move_page", title: "Move a page", write: true, idempotent: true,
		description: "Move a page below another page (or to the top level) and optionally right after a given sibling.",
	}, s.movePage)

	addTool(s, srv, toolDef{
		name: "archive_page", title: "Archive a page", write: true, destructive: true, idempotent: true,
		description: "Move a page and its subpages to the Trash. This is recoverable by people from the Trash; there is no tool that deletes permanently.",
	}, s.archivePage)

	addTool(s, srv, toolDef{
		name: "add_comment", title: "Add a comment", write: true,
		description: "Comment on a page: start a new thread on a block (default: the first block) or reply to an existing thread with thread_id.",
	}, s.addComment)
}

// ---------------------------------------------------------------- read tools

func (s *Server) listWorkspaces(ctx context.Context, c *call, _ listWorkspacesIn) (any, error) {
	memberships, err := s.o.Workspaces.List(ctx, c.userID())
	if err != nil {
		return nil, err
	}
	type workspace struct {
		ID   uuid.UUID `json:"id"`
		Name string    `json:"name"`
		Slug string    `json:"slug"`
		Role string    `json:"role"`
	}
	out := []workspace{}
	for _, m := range memberships {
		if c.workspaceAllowed(m.Workspace.Id) {
			out = append(out, workspace{ID: m.Workspace.Id, Name: m.Workspace.Name, Slug: m.Workspace.Slug, Role: string(m.Role)})
		}
	}
	return map[string]any{"workspaces": out}, nil
}

// snippetText turns a search snippet (HTML-escaped, matches in <mark>) into plain text with ** around matches.
func snippetText(s string) string {
	return html.UnescapeString(strings.NewReplacer("<mark>", "**", "</mark>", "**").Replace(s))
}

func (s *Server) searchPages(ctx context.Context, c *call, in searchPagesIn) (any, error) {
	ws, err := uuidArg("workspace_id", in.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if err := c.requireWorkspace(ctx, ws); err != nil {
		return nil, err
	}
	mode := content.SearchMode(in.Mode)
	switch mode {
	case "":
		mode = content.ModeFull
	case content.ModeFull, content.ModeTitle:
	default:
		return nil, apperr.FieldError("mode", "Must be full or title.")
	}
	limit := in.Limit
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > maxSearchResults {
		return nil, apperr.FieldError("limit", "Must be between 1 and 50.")
	}
	results, err := s.o.Content.Search(ctx, c.userID(), ws, in.Query, mode, limit)
	if err != nil {
		return nil, err
	}
	type result struct {
		pageItem
		Snippet string `json:"snippet,omitempty"`
	}
	out := make([]result, 0, len(results))
	for _, r := range results {
		item := result{pageItem: itemOf(r.Page)}
		if r.Snippet != nil {
			item.Snippet = snippetText(*r.Snippet)
		}
		out = append(out, item)
	}
	return map[string]any{"results": out, "truncated": len(out) >= limit}, nil
}

func (s *Server) listPages(ctx context.Context, c *call, in listPagesIn) (any, error) {
	ws, err := uuidArg("workspace_id", in.WorkspaceID)
	if err != nil {
		return nil, err
	}
	parent, err := optionalUUIDArg("parent_id", in.ParentID)
	if err != nil {
		return nil, err
	}
	if err := c.requireWorkspace(ctx, ws); err != nil {
		return nil, err
	}
	if parent != nil {
		acc, err := c.page(ctx, *parent, perm.View)
		if err != nil {
			return nil, err
		}
		if acc.WorkspaceID != ws {
			return nil, perm.ErrPageNotFound
		}
	}
	all, err := s.o.Pages.List(ctx, c.userID(), ws)
	if err != nil {
		return nil, err
	}
	selected := all
	if parent != nil {
		children := map[uuid.UUID][]gen.PageSummary{}
		for _, p := range all {
			if p.ParentId != nil {
				children[uuid.UUID(*p.ParentId)] = append(children[uuid.UUID(*p.ParentId)], p)
			}
		}
		selected = nil
		queue := []uuid.UUID{*parent}
		for len(queue) > 0 {
			next := queue[0]
			queue = queue[1:]
			for _, child := range children[next] {
				selected = append(selected, child)
				queue = append(queue, child.Id)
			}
		}
	}
	truncated := len(selected) > maxListPages
	if truncated {
		selected = selected[:maxListPages]
	}
	out := make([]pageItem, 0, len(selected))
	for _, p := range selected {
		out = append(out, itemOf(p))
	}
	return map[string]any{"pages": out, "truncated": truncated}, nil
}

func (s *Server) getPage(ctx context.Context, c *call, in pageIDIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	if _, err := c.page(ctx, id, perm.View); err != nil {
		return nil, err
	}
	detail, err := s.o.Pages.Get(ctx, c.userID(), id)
	if err != nil {
		return nil, err
	}
	body, err := s.o.Content.GetPageContent(ctx, c.userID(), id)
	if err != nil {
		return nil, err
	}
	markdown, truncated := capText(body.Markdown, maxMarkdownBytes)
	crumbs := make([]pageRef, 0, len(detail.Breadcrumbs))
	for _, b := range detail.Breadcrumbs {
		crumbs = append(crumbs, pageRef{ID: b.Id, Title: b.Title, Icon: b.Icon})
	}
	return map[string]any{
		"id": detail.Page.Id, "workspaceId": detail.Page.WorkspaceId, "title": detail.Page.Title, "icon": detail.Page.Icon,
		"role": detail.Page.Role, "breadcrumbs": crumbs, "updatedAt": detail.Page.UpdatedAt,
		"markdown": markdown, "truncated": truncated,
	}, nil
}

func (s *Server) getBacklinks(ctx context.Context, c *call, in pageIDIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	if _, err := c.page(ctx, id, perm.View); err != nil {
		return nil, err
	}
	refs, err := s.o.Content.Backlinks(ctx, c.userID(), id)
	if err != nil {
		return nil, err
	}
	truncated := len(refs) > maxListItems
	if truncated {
		refs = refs[:maxListItems]
	}
	out := make([]pageRef, 0, len(refs))
	for _, r := range refs {
		out = append(out, pageRef{ID: r.Id, Title: r.Title, Icon: r.Icon})
	}
	return map[string]any{"backlinks": out, "truncated": truncated}, nil
}

func (s *Server) listComments(ctx context.Context, c *call, in listCommentsIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	if _, err := c.page(ctx, id, perm.View); err != nil {
		return nil, err
	}
	threads, err := s.o.Comments.List(ctx, c.userID(), id, in.IncludeResolved)
	if err != nil {
		return nil, err
	}
	truncated := len(threads) > maxListItems
	if truncated {
		threads = threads[:maxListItems]
	}
	return map[string]any{"threads": threads, "truncated": truncated}, nil
}

// ---------------------------------------------------------------- write tools

func (s *Server) createPage(ctx context.Context, c *call, in createPageIn) (any, error) {
	ws, err := uuidArg("workspace_id", in.WorkspaceID)
	if err != nil {
		return nil, err
	}
	parent, err := optionalUUIDArg("parent_id", in.ParentID)
	if err != nil {
		return nil, err
	}
	if len(in.Markdown) > maxMarkdownBytes {
		return nil, apperr.FieldError("markdown", "Must be at most 1 MB.")
	}
	if err := c.requireWorkspace(ctx, ws); err != nil {
		return nil, err
	}
	if parent != nil {
		acc, err := c.page(ctx, *parent, perm.Edit)
		if err != nil {
			return nil, err
		}
		if acc.WorkspaceID != ws {
			return nil, perm.ErrPageNotFound
		}
	}
	input := pages.CreateInput{ParentID: parent, Title: in.Title}
	if in.Icon != "" {
		input.Icon = &in.Icon
	}
	page, _, err := s.o.Pages.Create(ctx, c.userID(), ws, input)
	if err != nil {
		return nil, err
	}
	c.pageID = page.Id.String()
	out := map[string]any{"id": page.Id, "workspaceId": page.WorkspaceId, "parentId": page.ParentId, "title": page.Title}
	if strings.TrimSpace(in.Markdown) != "" {
		// The page exists now; if the body cannot be written the agent must hear about it, but retrying the
		// whole call would create a second page, so report success with a warning instead of an error.
		resulting, err := s.apply(ctx, c, page.Id, collabclient.ApplyReplace, in.Markdown)
		if err != nil {
			_, message := describe(err)
			s.log.Warn("mcp create_page: initial content not applied", "page_id", page.Id, "err", err)
			out["contentApplied"] = false
			out["warning"] = "The page was created but its content could not be written (" + message + ") Use edit_page_content to add it."
		} else {
			out["contentApplied"] = true
			out["markdown"], _ = capText(resulting, maxMarkdownBytes)
		}
	}
	return out, nil
}

// apply sends Markdown to the live document through collab.
func (s *Server) apply(ctx context.Context, c *call, pageID uuid.UUID, mode collabclient.ApplyMode, markdown string) (string, error) {
	if s.o.Collab == nil {
		return "", collabclient.ErrNotConfigured
	}
	return s.o.Collab.ApplyMarkdown(ctx, collabclient.ApplyRequest{PageID: pageID, Markdown: markdown, Mode: mode, EditorID: c.userID()})
}

func (s *Server) updatePage(ctx context.Context, c *call, in updatePageIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	if in.Title == nil && in.Icon == nil {
		return nil, apperr.FieldError("title", "Provide a title and/or an icon.")
	}
	if _, err := c.page(ctx, id, perm.Edit); err != nil {
		return nil, err
	}
	update := pages.UpdateInput{Title: in.Title}
	if in.Icon != nil {
		update.SetIcon = true
		if *in.Icon != "" {
			update.Icon = in.Icon
		}
	}
	page, err := s.o.Pages.Update(ctx, c.userID(), id, update)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": page.Id, "title": page.Title, "icon": page.Icon, "updatedAt": page.UpdatedAt}, nil
}

func (s *Server) editPageContent(ctx context.Context, c *call, in editContentIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	mode := collabclient.ApplyMode(in.Mode)
	if !mode.Valid() {
		return nil, apperr.FieldError("mode", "Must be replace, append or prepend.")
	}
	if len(in.Markdown) > maxMarkdownBytes {
		return nil, apperr.FieldError("markdown", "Must be at most 1 MB.")
	}
	if _, err := c.page(ctx, id, perm.Edit); err != nil {
		return nil, err
	}
	resulting, err := s.apply(ctx, c, id, mode, in.Markdown)
	if err != nil {
		return nil, err
	}
	markdown, truncated := capText(resulting, maxMarkdownBytes)
	return map[string]any{"id": id, "mode": mode, "markdown": markdown, "truncated": truncated}, nil
}

func (s *Server) movePage(ctx context.Context, c *call, in movePageIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	parent, err := optionalUUIDArg("parent_id", in.ParentID)
	if err != nil {
		return nil, err
	}
	after, err := optionalUUIDArg("after_id", in.AfterID)
	if err != nil {
		return nil, err
	}
	acc, err := c.page(ctx, id, perm.Edit)
	if err != nil {
		return nil, err
	}
	// Related pages must be visible, in the same workspace and inside the token's reach before the service sees them.
	for _, related := range []struct {
		id  *uuid.UUID
		min perm.Role
	}{{parent, perm.Edit}, {after, perm.View}} {
		if related.id == nil {
			continue
		}
		other, err := c.page(ctx, *related.id, related.min)
		if err != nil {
			return nil, err
		}
		if other.WorkspaceID != acc.WorkspaceID {
			return nil, perm.ErrPageNotFound
		}
	}
	c.pageID = id.String()
	page, err := s.o.Pages.Move(ctx, c.userID(), id, pages.MoveInput{ParentID: parent, AfterID: after})
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": page.Id, "parentId": page.ParentId, "position": page.Position}, nil
}

func (s *Server) archivePage(ctx context.Context, c *call, in pageIDIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	if _, err := c.page(ctx, id, perm.Full); err != nil {
		return nil, err
	}
	if err := s.o.Pages.Archive(ctx, c.userID(), id); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "archived": true, "note": "The page and its subpages are in the Trash and can be restored from there."}, nil
}

func (s *Server) addComment(ctx context.Context, c *call, in addCommentIn) (any, error) {
	id, err := uuidArg("page_id", in.PageID)
	if err != nil {
		return nil, err
	}
	thread, err := optionalUUIDArg("thread_id", in.ThreadID)
	if err != nil {
		return nil, err
	}
	if _, err := c.page(ctx, id, perm.Comment); err != nil {
		return nil, err
	}

	if thread != nil {
		// The thread must belong to this page (and so to a workspace the token may use).
		threads, err := s.o.Comments.List(ctx, c.userID(), id, true)
		if err != nil {
			return nil, err
		}
		found := false
		for _, t := range threads {
			if uuid.UUID(t.Id) == *thread {
				found = true
				break
			}
		}
		if !found {
			return nil, apperr.NotFound("Comment thread not found on this page.")
		}
		comment, err := s.o.Comments.Reply(ctx, c.userID(), *thread, in.Body)
		if err != nil {
			return nil, err
		}
		return map[string]any{"threadId": comment.ThreadId, "commentId": comment.Id}, nil
	}

	blockID := strings.TrimSpace(in.BlockID)
	if blockID == "" {
		body, err := s.o.Content.GetPageContent(ctx, c.userID(), id)
		if err != nil {
			return nil, err
		}
		for _, b := range body.Blocks {
			if bid, ok := b["id"].(string); ok && bid != "" {
				blockID = bid
				break
			}
		}
		if blockID == "" {
			return nil, apperr.FieldError("block_id", "The page has no content to attach a comment to yet; pass block_id or add content first.")
		}
	}
	created, err := s.o.Comments.Create(ctx, c.userID(), id, comments.CreateThreadInput{BlockID: blockID, Body: in.Body})
	if err != nil {
		return nil, err
	}
	out := map[string]any{"threadId": created.Id, "blockId": created.BlockId}
	if len(created.Comments) > 0 {
		out["commentId"] = created.Comments[0].Id
	}
	return out, nil
}
