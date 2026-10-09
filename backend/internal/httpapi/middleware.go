package httpapi

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/auth"
)

// statusRecorder captures the status and size for the access log while staying transparent for
// http.ResponseController (Flush, SetWriteDeadline) through Unwrap.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
	wrote  bool
}

func (w *statusRecorder) WriteHeader(code int) {
	if !w.wrote {
		w.status, w.wrote = code, true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if !w.wrote {
		w.status, w.wrote = http.StatusOK, true
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

// requestID assigns an id (or accepts a sane inbound one) and echoes it in X-Request-Id.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			id = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxRequestID, id)))
	})
}

func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// recoverer turns panics into logged 500s.
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil || rec == http.ErrAbortHandler {
				if rec != nil {
					panic(rec)
				}
				return
			}
			s.Log.Error("panic in handler", "request_id", requestIDFrom(r.Context()), "panic", rec, "stack", string(debug.Stack()))
			writeAppError(w, apperr.Internal(nil))
		}()
		next.ServeHTTP(w, r)
	})
}

// accessLog writes one structured line per request. It logs the route pattern, never the raw path
// or query string, so invite/share/reset tokens and OIDC codes stay out of the logs.
func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		state := &logState{}
		next.ServeHTTP(rec, r.WithContext(context.WithValue(r.Context(), ctxLogState, state)))

		attrs := []any{
			"request_id", requestIDFrom(r.Context()),
			"method", r.Method,
			"route", routePattern(r),
			"status", rec.status,
			"bytes", rec.bytes,
			"duration_ms", time.Since(start).Milliseconds(),
			"ip", clientIP(r),
		}
		if state.userID != "" {
			attrs = append(attrs, "user", state.userID)
		}
		switch {
		case rec.status >= 500:
			s.Log.Error("request", attrs...)
		case strings.HasSuffix(routePattern(r), "/healthz"):
			s.Log.Debug("request", attrs...)
		default:
			s.Log.Info("request", attrs...)
		}
	})
}

// apiHeaders sets the defaults for API responses; handlers that stream files override them.
func apiHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// csrfExempt lists the mutating endpoints that may be called without an Origin header (e.g. curl)
// as long as no session cookie is sent (conventions §2).
var csrfExempt = map[string]bool{
	"/auth/login":                  true,
	"/setup":                       true,
	"/auth/register":               true,
	"/auth/password-reset/confirm": true,
}

// originCheck is the CSRF defence of conventions §2: state-changing requests must come from an
// allowed Origin. A request without Origin is only accepted for the exempt endpoints and only when
// it carries no session cookie. Safe methods are not restricted (browsers omit Origin on same-origin
// GETs), but a present, foreign Origin is rejected so cross-origin pages cannot open the SSE stream.
func (s *Server) originCheck(next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(s.Config.AllowedOrigins))
	for _, o := range s.Config.AllowedOrigins {
		allowed[o] = true
	}
	deny := func(w http.ResponseWriter) {
		writeAppError(w, apperr.Forbidden("Cross-origin request blocked."))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		safe := r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions
		switch {
		case origin != "":
			if !allowed[strings.ToLower(origin)] {
				deny(w)
				return
			}
		case safe:
		default:
			_, hasCookie := sessionCookie(r)
			path := strings.TrimPrefix(r.URL.Path, "/api")
			if hasCookie || !csrfExempt[path] {
				deny(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// notImplementedEnvelope gives the 501s of operations wave 2 has not implemented yet the standard
// error envelope instead of an empty body.
func notImplementedEnvelope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&envelope501Writer{ResponseWriter: w}, r)
	})
}

type envelope501Writer struct {
	http.ResponseWriter
	done bool
}

func (w *envelope501Writer) WriteHeader(code int) {
	if code == http.StatusNotImplemented && !w.done {
		w.done = true
		writeJSON(w.ResponseWriter, code, errorBody{Error: errorDetail{Code: apperr.CodeInternal, Message: "This endpoint is not implemented yet."}})
		return
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *envelope501Writer) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// sessionMiddleware authenticates the cookie. Operations that the contract protects with cookieAuth
// get a 401 without a valid session; public operations get the session attached when there is one.
func (s *Server) sessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, hasCookie := sessionCookie(r)
		var p *auth.Principal
		if hasCookie {
			var refreshed *time.Time
			var err error
			p, refreshed, err = s.Auth.Authenticate(r.Context(), token)
			if err != nil {
				s.writeError(w, r, err)
				return
			}
			if p != nil && refreshed != nil {
				s.setSessionCookie(w, token, *refreshed)
			}
		}
		if p == nil {
			if s.operations.requiresSession(r) {
				if hasCookie {
					s.clearSessionCookie(w) // stale cookie: let the browser drop it
				}
				writeAppError(w, apperr.Unauthorized("Sign in to continue."))
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if st, ok := r.Context().Value(ctxLogState).(*logState); ok {
			st.userID = p.User.ID.String()
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxPrincipal, p)))
	})
}

// operationTable answers "does this route need a session?" from the embedded OpenAPI contract.
type operationTable struct {
	required map[string]bool // "GET /pages/{pageId}" -> true
}

func (t operationTable) requiresSession(r *http.Request) bool {
	pattern := strings.TrimPrefix(routePattern(r), "/api")
	req, known := t.required[r.Method+" "+pattern]
	return !known || req // unknown routes fail closed
}

// internalAuth guards the internal listener with the shared bearer token (constant-time compare).
func (s *Server) internalAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "Bearer "
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, prefix) || !constantTimeEqual(h[len(prefix):], s.Config.InternalToken) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeAppError(w, apperr.Unauthorized("Invalid internal token."))
			return
		}
		next.ServeHTTP(w, r)
	})
}
