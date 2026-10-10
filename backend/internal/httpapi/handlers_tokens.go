package httpapi

import (
	"net/http"

	"github.com/google/uuid"

	"hostidian/backend/internal/apitokens"
	"hostidian/backend/internal/httpapi/gen"
)

// apiTokensService is shared by the token endpoints and the MCP endpoint (it holds the rate limiter).
func apiTokensService(s *Server) *apitokens.Service {
	return Ext(s, "apitokens", func() *apitokens.Service {
		return apitokens.NewService(apitokens.Options{Q: s.Deps.Q, Log: s.Log, PublicURL: s.Config.PublicURL})
	})
}

// Access tokens are managed with the browser session only. Bearer tokens are accepted on /api/mcp and
// nowhere else, so a token can never reach these handlers (conventions §13).

// ListApiTokens: GET /auth/tokens
func (s *Server) ListApiTokens(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := apiTokensService(s).List(r.Context(), p.User.ID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateApiToken: POST /auth/tokens
func (s *Server) CreateApiToken(w http.ResponseWriter, r *http.Request) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.CreateApiTokenJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	in := apitokens.CreateInput{Name: body.Name, Scope: string(body.Scope), ExpiresInDays: body.ExpiresInDays}
	if body.WorkspaceId != nil {
		id := uuid.UUID(*body.WorkspaceId)
		in.WorkspaceID = &id
	}
	out, err := apiTokensService(s).Create(r.Context(), p.User.ID, in)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, out)
}

// RevokeApiToken: DELETE /auth/tokens/{tokenId}
func (s *Server) RevokeApiToken(w http.ResponseWriter, r *http.Request, tokenId uuid.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := apiTokensService(s).Revoke(r.Context(), p.User.ID, tokenId); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}
