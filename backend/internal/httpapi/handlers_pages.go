package httpapi

import (
	"net/http"

	"github.com/google/uuid"

	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/pages"
)

func uuidPtr(p *gen.PageId) *uuid.UUID {
	if p == nil {
		return nil
	}
	id := uuid.UUID(*p)
	return &id
}

// ListPages: GET /workspaces/{workspaceId}/pages
func (s *Server) ListPages(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Pages.List(r.Context(), p.User.ID, workspaceId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// CreatePage: POST /workspaces/{workspaceId}/pages
func (s *Server) CreatePage(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.CreatePageJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := pages.CreateInput{
		ID: uuidPtr(body.Id), ParentID: uuidPtr(body.ParentId), Icon: body.Icon,
		AfterID: uuidPtr(body.AfterId), BeforeID: uuidPtr(body.BeforeId),
	}
	if body.Title != nil {
		in.Title = *body.Title
	}
	if body.Visibility != nil {
		v := string(*body.Visibility)
		in.Visibility = &v
	}
	page, created, err := s.Pages.Create(r.Context(), p.User.ID, workspaceId, in)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, page)
}

// ListTrash: GET /workspaces/{workspaceId}/trash
func (s *Server) ListTrash(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Pages.Trash(r.Context(), p.User.ID, workspaceId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// ListFavorites: GET /workspaces/{workspaceId}/favorites
func (s *Server) ListFavorites(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Pages.Favorites(r.Context(), p.User.ID, workspaceId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// ListRecentPages: GET /workspaces/{workspaceId}/recent
func (s *Server) ListRecentPages(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId, params gen.ListRecentPagesParams) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	limit := 15
	if params.Limit != nil {
		limit = *params.Limit
	}
	list, err := s.Pages.Recent(r.Context(), p.User.ID, workspaceId, limit)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// GetPage: GET /pages/{pageId}
func (s *Server) GetPage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	detail, err := s.Pages.Get(r.Context(), p.User.ID, pageId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if svc := githubSync(s); svc != nil {
		// Best effort: a failed lookup must not break opening the page.
		if link, err := svc.PageLink(r.Context(), pageId); err != nil {
			s.Log.Warn("github link lookup", "page", pageId, "err", err)
		} else {
			detail.Github = toGenPageGithub(link)
		}
	}
	writeJSON(w, http.StatusOK, detail)
}

// UpdatePage: PATCH /pages/{pageId}
func (s *Server) UpdatePage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		Title *string          `json:"title"`
		Icon  optional[string] `json:"icon"`  // present-but-null clears
		Cover optional[string] `json:"cover"` // present-but-null clears
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	page, err := s.Pages.Update(r.Context(), p.User.ID, pageId, pages.UpdateInput{
		Title: body.Title, SetIcon: body.Icon.Set, Icon: body.Icon.Value, SetCover: body.Cover.Set, Cover: body.Cover.Value,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// PurgePage: DELETE /pages/{pageId}
func (s *Server) PurgePage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Pages.Purge(r.Context(), p.User.ID, pageId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// MovePage: POST /pages/{pageId}/move
func (s *Server) MovePage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	// parentId is required but nullable (null = top level), so its presence matters.
	body, err := decodeJSON[struct {
		ParentID optional[uuid.UUID] `json:"parentId"`
		AfterID  *uuid.UUID          `json:"afterId"`
		BeforeID *uuid.UUID          `json:"beforeId"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if !body.ParentID.Set {
		s.writeError(w, r, fieldRequired("parentId"))
		return
	}
	page, err := s.Pages.Move(r.Context(), p.User.ID, pageId, pages.MoveInput{
		ParentID: body.ParentID.Value, AfterID: body.AfterID, BeforeID: body.BeforeID,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// DuplicatePage: POST /pages/{pageId}/duplicate
func (s *Server) DuplicatePage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	include := true
	// The body is optional.
	if body, err := decodeJSON[gen.DuplicatePageJSONBody](w, r); err == nil {
		if body.IncludeSubpages != nil {
			include = *body.IncludeSubpages
		}
	} else if err != errEmptyBody {
		s.writeError(w, r, err)
		return
	}
	page, err := s.Pages.Duplicate(r.Context(), p.User.ID, pageId, include)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, page)
}

// ArchivePage: POST /pages/{pageId}/archive
func (s *Server) ArchivePage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Pages.Archive(r.Context(), p.User.ID, pageId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// RestorePage: POST /pages/{pageId}/restore
func (s *Server) RestorePage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	page, err := s.Pages.Restore(r.Context(), p.User.ID, pageId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// AddFavorite: PUT /pages/{pageId}/favorite
func (s *Server) AddFavorite(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Pages.AddFavorite(r.Context(), p.User.ID, pageId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// RemoveFavorite: DELETE /pages/{pageId}/favorite
func (s *Server) RemoveFavorite(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Pages.RemoveFavorite(r.Context(), p.User.ID, pageId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// GetPagePermissions: GET /pages/{pageId}/permissions
func (s *Server) GetPagePermissions(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	perms, err := s.Pages.Permissions(r.Context(), p.User.ID, pageId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, perms)
}

// GrantPagePermission: POST /pages/{pageId}/permissions
func (s *Server) GrantPagePermission(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		UserID *uuid.UUID `json:"userId"`
		Email  *string    `json:"email"`
		Role   string     `json:"role"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := pages.GrantInput{Role: body.Role, UserID: body.UserID, Email: body.Email}
	perms, err := s.Pages.Grant(r.Context(), p.User.ID, pageId, in)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, perms)
}

// RevokePagePermission: DELETE /pages/{pageId}/permissions/{userId}
func (s *Server) RevokePagePermission(w http.ResponseWriter, r *http.Request, pageId gen.PageId, userId gen.UserId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	perms, err := s.Pages.Revoke(r.Context(), p.User.ID, pageId, userId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, perms)
}

// SetPageVisibility: PUT /pages/{pageId}/visibility
func (s *Server) SetPageVisibility(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		Visibility string `json:"visibility"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	perms, err := s.Pages.SetVisibility(r.Context(), p.User.ID, pageId, body.Visibility)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, perms)
}

// CreateCollabToken: POST /pages/{pageId}/collab-token
func (s *Server) CreateCollabToken(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	tok, err := s.Pages.CollabToken(r.Context(), p.User.ID, pageId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tok)
}
