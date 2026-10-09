package httpapi

import (
	"net/http"

	openapi_types "github.com/oapi-codegen/runtime/types"

	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/workspaces"
)

// ListWorkspaces: GET /workspaces
func (s *Server) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Workspaces.List(r.Context(), p.User.ID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// CreateWorkspace: POST /workspaces
func (s *Server) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.CreateWorkspaceJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	ws, err := s.Workspaces.Create(r.Context(), p.User.ID, p.User.IsInstanceAdmin, workspaces.CreateInput{
		Name: body.Name, Slug: body.Slug, Icon: body.Icon,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, ws)
}

// GetWorkspace: GET /workspaces/{workspaceId}
func (s *Server) GetWorkspace(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	ws, err := s.Workspaces.Get(r.Context(), p.User.ID, workspaceId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// UpdateWorkspace: PATCH /workspaces/{workspaceId}
func (s *Server) UpdateWorkspace(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		Name *string          `json:"name"`
		Slug *string          `json:"slug"`
		Icon optional[string] `json:"icon"` // present-but-null clears the icon
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	ws, err := s.Workspaces.Update(r.Context(), p.User.ID, workspaceId, workspaces.UpdateInput{
		Name: body.Name, Slug: body.Slug, SetIcon: body.Icon.Set, Icon: body.Icon.Value,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ws)
}

// DeleteWorkspace: DELETE /workspaces/{workspaceId}
func (s *Server) DeleteWorkspace(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Workspaces.Delete(r.Context(), p.User.ID, workspaceId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// ListMembers: GET /workspaces/{workspaceId}/members
func (s *Server) ListMembers(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Workspaces.ListMembers(r.Context(), p.User.ID, workspaceId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// UpdateMember: PATCH /workspaces/{workspaceId}/members/{userId}
func (s *Server) UpdateMember(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId, userId gen.UserId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		Role string `json:"role"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	m, err := s.Workspaces.UpdateMember(r.Context(), p.User.ID, workspaceId, userId, body.Role)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// RemoveMember: DELETE /workspaces/{workspaceId}/members/{userId}
func (s *Server) RemoveMember(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId, userId gen.UserId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Workspaces.RemoveMember(r.Context(), p.User.ID, workspaceId, userId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// ListInvites: GET /workspaces/{workspaceId}/invites
func (s *Server) ListInvites(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Workspaces.ListInvites(r.Context(), p.User.ID, workspaceId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// CreateInvite: POST /workspaces/{workspaceId}/invites
func (s *Server) CreateInvite(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		Role          string  `json:"role"`
		Email         *string `json:"email"`
		ExpiresInDays *int    `json:"expiresInDays"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := workspaces.InviteInput{Role: body.Role, Email: body.Email, ExpiresInDays: body.ExpiresInDays}
	inv, err := s.Workspaces.CreateInvite(r.Context(), p.User.ID, workspaceId, in)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, inv)
}

// RevokeInvite: DELETE /workspaces/{workspaceId}/invites/{inviteId}
func (s *Server) RevokeInvite(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId, inviteId openapi_types.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Workspaces.RevokeInvite(r.Context(), p.User.ID, workspaceId, inviteId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}
