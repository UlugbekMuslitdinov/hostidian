package httpapi

import (
	"context"
	"net"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/auth"
)

type ctxKey int

const (
	ctxPrincipal ctxKey = iota
	ctxRequestID
	ctxLogState
)

// logState lets the access-log middleware see values set deeper in the chain.
type logState struct {
	userID string
}

func requestIDFrom(ctx context.Context) string {
	id, _ := ctx.Value(ctxRequestID).(string)
	return id
}

// principal returns the authenticated caller, or nil.
func principal(r *http.Request) *auth.Principal {
	p, _ := r.Context().Value(ctxPrincipal).(*auth.Principal)
	return p
}

// requireUser returns the caller; it answers 401 itself and returns false when there is none (a
// defensive net: the session middleware already rejects unauthenticated calls to protected routes).
func (s *Server) requireUser(w http.ResponseWriter, r *http.Request) (*auth.Principal, bool) {
	p := principal(r)
	if p == nil {
		writeAppError(w, apperr.Unauthorized("Sign in to continue."))
		return nil, false
	}
	return p, true
}

// routePattern is the matched chi route ("/api/pages/{pageId}"), safe to log (no ids or tokens).
func routePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return "unmatched"
}

// clientMeta describes the caller for sessions and rate limiting.
func clientMeta(r *http.Request) auth.ClientMeta {
	return auth.ClientMeta{IP: clientIP(r), UserAgent: r.UserAgent()}
}

// clientIP returns the caller's address. Behind our reverse proxy (a loopback/private peer) the
// right-most X-Forwarded-For entry — the one the proxy appended — is used; direct peers are never
// allowed to spoof it.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !(ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		return host
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if last := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(last) != nil {
			return last
		}
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); net.ParseIP(xr) != nil {
		return xr
	}
	return host
}
