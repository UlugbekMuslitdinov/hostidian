package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/mcp"
)

// mcpHandler is the MCP endpoint (conventions §13). It is not part of the OpenAPI contract and does not use
// the session cookie: it authenticates `Authorization: Bearer hst_…` access tokens itself.
func mcpHandler(s *Server) *mcp.Server {
	return Ext(s, "mcp", func() *mcp.Server {
		// The production Collab client applies edits; test doubles that only record disconnects fall back to a
		// client built from the configuration (which reports "not configured" when COLLAB_INTERNAL_URL is empty).
		applier, ok := s.Collab.(collabclient.Applier)
		if !ok {
			applier = collabclient.New(s.Config.CollabInternalURL, s.Config.InternalToken, s.Log)
		}
		return mcp.New(mcp.Options{
			Enabled:        s.Config.MCPEnabled,
			AllowedOrigins: s.Config.AllowedOrigins,
			Version:        s.Config.Version,
			Log:            s.Log,
			Q:              s.Deps.Q,
			Tokens:         apiTokensService(s),
			Pages:          s.Pages,
			Content:        contentService(s),
			Comments:       commentsService(s),
			Workspaces:     s.Workspaces,
			Collab:         applier,
			OnAuthenticated: func(r *http.Request, userID uuid.UUID) {
				if st, ok := r.Context().Value(ctxLogState).(*logState); ok {
					st.userID = userID.String()
				}
			},
		})
	})
}

// mountPublicRoutes adds the routes that live under /api but outside the generated router: they must not
// pass the session/CSRF middleware of the REST API (MCP clients send a bearer token and no Origin).
func (s *Server) mountPublicRoutes(root chi.Router) {
	h := mcpHandler(s)
	root.Handle("/api/mcp", h)
	root.Handle("/api/mcp/", h)
}
