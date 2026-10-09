// Package httpapi is the HTTP layer: the public router (/api, generated from api/openapi.yaml) and
// the internal router (service-to-service).
//
// Adding an endpoint (wave 2): implement the generated method on *Server in a new handlers_*.go
// file — it shadows gen.Unimplemented's 501 stub, no edit of existing files needed. Services that
// are not part of the core are built lazily with Ext. Internal endpoints register themselves with
// RegisterInternalRoutes from an init() in their own file.
package httpapi

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/auth"
	"hostidian/backend/internal/deps"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/oidc"
	"hostidian/backend/internal/pages"
	"hostidian/backend/internal/workspaces"
)

// Server implements gen.ServerInterface. Every operation without a method of its own answers 501
// through the embedded gen.Unimplemented.
type Server struct {
	gen.Unimplemented
	*deps.Deps

	Auth       *auth.Service
	Workspaces *workspaces.Service
	Pages      *pages.Service
	OIDC       *oidc.Provider

	operations operationTable

	extMu sync.Mutex
	ext   map[string]any
}

// Options customise NewServer (tests inject a fast hasher, a clock, a fake IdP client).
type Options struct {
	Hasher     *auth.Hasher
	Limiter    *auth.Limiter
	Now        func() time.Time
	OIDCClient *http.Client
}

// NewServer wires the domain services.
func NewServer(d *deps.Deps, o Options) (*Server, error) {
	ops, err := buildOperationTable()
	if err != nil {
		return nil, err
	}
	s := &Server{Deps: d, operations: ops, ext: map[string]any{}}
	s.Auth = auth.NewService(auth.Options{
		Config: d.Config, Pool: d.Pool, Broker: d.Broker, Collab: d.Collab, Hasher: o.Hasher, Limiter: o.Limiter,
		Log: d.Log, Now: o.Now,
	})
	s.Workspaces = workspaces.NewService(workspaces.Options{
		Pool: d.Pool, Broker: d.Broker, Collab: d.Collab, PublicURL: d.Config.PublicURL, Log: d.Log, Now: o.Now,
	})
	s.Pages = pages.NewService(pages.Options{
		Pool: d.Pool, Broker: d.Broker, Collab: d.Collab, Log: d.Log, Now: o.Now,
		CollabSecret: d.Config.CollabJWTSecret, CollabPublicURL: d.Config.CollabPublicURL,
	})
	s.OIDC = oidc.New(d.Config.OIDC, d.Config.AppSecret, d.Config.CookieSecure, o.OIDCClient)
	return s, nil
}

// Ext returns the lazily built, cached extension value for key (wave-2 services). init runs at
// most once.
func Ext[T any](s *Server, key string, init func() T) T {
	s.extMu.Lock()
	defer s.extMu.Unlock()
	if v, ok := s.ext[key]; ok {
		return v.(T)
	}
	v := init()
	s.ext[key] = v
	return v
}

// buildOperationTable reads the embedded contract and records which operations are protected by
// the cookieAuth scheme (default security applies unless an operation overrides it).
func buildOperationTable() (operationTable, error) {
	doc, err := gen.GetSwagger()
	if err != nil {
		return operationTable{}, fmt.Errorf("load embedded openapi spec: %w", err)
	}
	t := operationTable{required: map[string]bool{}}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			sec := doc.Security
			if op.Security != nil {
				sec = *op.Security
			}
			t.required[method+" "+path] = len(sec) > 0
		}
	}
	return t, nil
}

// Handler is the public listener: /healthz and the API under /api.
func (s *Server) Handler() http.Handler {
	api := chi.NewRouter()
	api.Use(apiHeaders, s.originCheck)
	gen.HandlerWithOptions(s, gen.ChiServerOptions{
		BaseRouter:       api,
		Middlewares:      []gen.MiddlewareFunc{notImplementedEnvelope, s.sessionMiddleware},
		ErrorHandlerFunc: s.paramError,
	})
	api.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeAppError(w, apperr.NotFound("No such endpoint."))
	})
	api.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeAppError(w, apperr.New(http.StatusMethodNotAllowed, apperr.CodeBadRequest, "Method not allowed."))
	})

	root := chi.NewRouter()
	root.Use(requestID, s.accessLog, s.recoverer)
	root.Get("/healthz", s.healthz)
	root.Mount("/api", api)
	return root
}

// paramError reports malformed path/query parameters as 400s.
func (s *Server) paramError(w http.ResponseWriter, r *http.Request, err error) {
	writeAppError(w, apperr.BadRequest("Invalid request parameter."))
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.Pool.Ping(ctx); err != nil {
		s.Log.Warn("health check failed", "err", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
