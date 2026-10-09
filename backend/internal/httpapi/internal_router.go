package httpapi

import (
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"

	"hostidian/backend/internal/apperr"
)

// InternalRoutes registers handlers on the internal router. The router is mounted at /internal, so
// a route registered as "/pages/{pageId}/content" is served at /internal/pages/{pageId}/content.
type InternalRoutes func(s *Server, r chi.Router)

var (
	internalMu     sync.Mutex
	internalRoutes []InternalRoutes
)

// RegisterInternalRoutes adds routes to the internal API. Call it from an init() in the file that
// implements the endpoint (wave 2: PUT /pages/{pageId}/content). Every route is behind the bearer
// INTERNAL_TOKEN check.
func RegisterInternalRoutes(f InternalRoutes) {
	internalMu.Lock()
	defer internalMu.Unlock()
	internalRoutes = append(internalRoutes, f)
}

// InternalHandler is the service-to-service listener (INTERNAL_ADDR). It must never be exposed
// publicly; Caddy does not route to it.
func (s *Server) InternalHandler() http.Handler {
	r := chi.NewRouter()
	r.Use(requestID, s.accessLog, s.recoverer, apiHeaders)
	r.Get("/healthz", s.healthz)
	r.Get("/internal/health", s.healthz)
	r.Route("/internal", func(r chi.Router) {
		r.Use(s.internalAuth)
		internalMu.Lock()
		defer internalMu.Unlock()
		for _, register := range internalRoutes {
			register(s, r)
		}
	})
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeAppError(w, apperr.NotFound("No such endpoint."))
	})
	return r
}
