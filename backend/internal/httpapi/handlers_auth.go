package httpapi

import (
	"net/http"

	"github.com/google/uuid"

	"hostidian/backend/internal/auth"
	"hostidian/backend/internal/httpapi/gen"
)

// GetInstanceInfo: GET /instance/info
func (s *Server) GetInstanceInfo(w http.ResponseWriter, r *http.Request) {
	info, err := s.Auth.InstanceInfo(r.Context())
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

// SetupInstance: POST /setup
func (s *Server) SetupInstance(w http.ResponseWriter, r *http.Request) {
	// Local body types use plain strings for emails: the generated type rejects malformed addresses
	// while decoding (a 400), whereas the contract wants a 422 with field details.
	body, err := decodeJSON[struct {
		Name          string  `json:"name"`
		Email         string  `json:"email"`
		Password      string  `json:"password"`
		WorkspaceName *string `json:"workspaceName"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := auth.SetupInput{Name: body.Name, Email: body.Email, Password: body.Password}
	if body.WorkspaceName != nil {
		in.WorkspaceName = *body.WorkspaceName
	}
	me, sess, err := s.Auth.Setup(r.Context(), in, clientMeta(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.setSessionCookie(w, sess.Token, sess.ExpiresAt)
	writeJSON(w, http.StatusCreated, me)
}

// Login: POST /auth/login
func (s *Server) Login(w http.ResponseWriter, r *http.Request) {
	body, err := decodeJSON[struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	me, sess, err := s.Auth.Login(r.Context(), body.Email, body.Password, clientMeta(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.setSessionCookie(w, sess.Token, sess.ExpiresAt)
	writeJSON(w, http.StatusOK, me)
}

// Logout: POST /auth/logout
func (s *Server) Logout(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Auth.Logout(r.Context(), p); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.clearSessionCookie(w)
	noContent(w)
}

// GetMe: GET /auth/me
func (s *Server) GetMe(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	me, err := s.Auth.Me(r.Context(), p.User)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, me)
}

// Register: POST /auth/register
func (s *Server) Register(w http.ResponseWriter, r *http.Request) {
	body, err := decodeJSON[struct {
		Name        string  `json:"name"`
		Email       string  `json:"email"`
		Password    string  `json:"password"`
		InviteToken *string `json:"inviteToken"`
	}](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := auth.RegisterInput{Name: body.Name, Email: body.Email, Password: body.Password}
	if body.InviteToken != nil {
		in.InviteToken = *body.InviteToken
	}
	me, sess, err := s.Auth.Register(r.Context(), in, clientMeta(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.setSessionCookie(w, sess.Token, sess.ExpiresAt)
	writeJSON(w, http.StatusCreated, me)
}

// GetInviteInfo: GET /auth/invites/{token}
func (s *Server) GetInviteInfo(w http.ResponseWriter, r *http.Request, token string) {
	info, err := s.Auth.InviteInfo(r.Context(), token)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

// AcceptInvite: POST /auth/invites/{token}
func (s *Server) AcceptInvite(w http.ResponseWriter, r *http.Request, token string) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	me, err := s.Auth.AcceptInvite(r.Context(), p, token)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, me)
}

// ConfirmPasswordReset: POST /auth/password-reset/confirm
func (s *Server) ConfirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	body, err := decodeJSON[gen.ConfirmPasswordResetJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := s.Auth.ConfirmPasswordReset(r.Context(), body.Token, body.NewPassword, clientMeta(r)); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// UpdateProfile: PATCH /auth/profile
func (s *Server) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.UpdateProfileJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	u, err := s.Auth.UpdateProfile(r.Context(), p, auth.ProfileInput{Name: body.Name, AvatarColor: body.AvatarColor})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// ChangePassword: POST /auth/password
func (s *Server) ChangePassword(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.ChangePasswordJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	current := ""
	if body.CurrentPassword != nil {
		current = *body.CurrentPassword
	}
	if err := s.Auth.ChangePassword(r.Context(), p, current, body.NewPassword); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// ListSessions: GET /auth/sessions
func (s *Server) ListSessions(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	list, err := s.Auth.ListSessions(r.Context(), p)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// RevokeSession: DELETE /auth/sessions/{sessionId}
func (s *Server) RevokeSession(w http.ResponseWriter, r *http.Request, sessionId gen.SessionId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := s.Auth.RevokeSession(r.Context(), p, uuid.UUID(sessionId)); err != nil {
		s.writeError(w, r, err)
		return
	}
	if sessionId == p.SessionID {
		s.clearSessionCookie(w)
	}
	noContent(w)
}
