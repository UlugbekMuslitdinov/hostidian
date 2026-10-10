package httpapi

import (
	"net/http"

	"github.com/google/uuid"

	"hostidian/backend/internal/auth"
	"hostidian/backend/internal/httpapi/gen"
)

// AdminListUsers: GET /admin/users
func (s *Server) AdminListUsers(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	users, err := s.Auth.AdminListUsers(r.Context(), p)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// AdminUpdateUser: PATCH /admin/users/{userId}
func (s *Server) AdminUpdateUser(w http.ResponseWriter, r *http.Request, userId gen.UserId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.AdminUpdateUserJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	u, err := s.Auth.AdminUpdateUser(r.Context(), p, userId, auth.AdminUpdateInput{Disabled: body.Disabled, IsInstanceAdmin: body.IsInstanceAdmin})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// AdminCreateResetLink: POST /admin/users/{userId}/reset-link
func (s *Server) AdminCreateResetLink(w http.ResponseWriter, r *http.Request, userId gen.UserId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	url, expires, err := s.Auth.CreateResetLink(r.Context(), p, userId)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"url": url, "expiresAt": expires.UTC()})
}

// AdminGetSettings: GET /admin/settings
func (s *Server) AdminGetSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	st, err := s.Auth.GetSettings(r.Context(), p)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// AdminUpdateSettings: PATCH /admin/settings
func (s *Server) AdminUpdateSettings(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.AdminUpdateSettingsJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	st, err := s.Auth.UpdateSettings(r.Context(), p, auth.SettingsInput{
		InstanceName: body.InstanceName, AllowOpenSignup: body.AllowOpenSignup, AllowWorkspaceCreation: body.AllowWorkspaceCreation,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// AdminCreateUser: POST /admin/users
func (s *Server) AdminCreateUser(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[struct {
		Name            string  `json:"name"`
		Email           string  `json:"email"`
		Password        *string `json:"password"`
		IsInstanceAdmin bool    `json:"isInstanceAdmin"`
		Memberships     []struct {
			WorkspaceID uuid.UUID `json:"workspaceId"`
			Role        string    `json:"role"`
		} `json:"memberships"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := auth.AdminCreateUserInput{Name: body.Name, Email: body.Email, Password: body.Password, IsInstanceAdmin: body.IsInstanceAdmin}
	for _, m := range body.Memberships {
		in.Memberships = append(in.Memberships, auth.AdminMembership{WorkspaceID: m.WorkspaceID, Role: m.Role})
	}
	out, err := s.Auth.AdminCreateUser(r.Context(), p, in)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}
