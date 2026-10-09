package httpapi

import (
	"errors"
	"net/http"
	"net/url"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/oidc"
)

// OidcLogin: GET /auth/oidc/login — redirects to the identity provider.
func (s *Server) OidcLogin(w http.ResponseWriter, r *http.Request, params gen.OidcLoginParams) {
	if !s.OIDC.Enabled() {
		writeAppError(w, apperr.NotFound("Single sign-on is not configured."))
		return
	}
	invite, next := "", ""
	if params.Invite != nil {
		invite = *params.Invite
	}
	if params.Next != nil {
		next = *params.Next
	}
	authURL, cookie, err := s.OIDC.Begin(r.Context(), invite, next)
	if err != nil {
		var fe *oidc.FlowError
		if errors.As(err, &fe) {
			s.Log.Warn("oidc begin failed", "err", err)
			s.redirectToLogin(w, r, fe.Code)
			return
		}
		s.writeError(w, r, err)
		return
	}
	http.SetCookie(w, cookie)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// OidcCallback: GET /auth/oidc/callback — completes the login and redirects into the app.
func (s *Server) OidcCallback(w http.ResponseWriter, r *http.Request, params gen.OidcCallbackParams) {
	if !s.OIDC.Enabled() {
		writeAppError(w, apperr.NotFound("Single sign-on is not configured."))
		return
	}
	http.SetCookie(w, s.OIDC.ClearCookie()) // the state cookie is single-use
	if params.Error != nil && *params.Error != "" {
		s.Log.Info("oidc provider returned an error", "error", *params.Error)
		s.redirectToLogin(w, r, "oidc_denied")
		return
	}
	code, state := deref(params.Code), deref(params.State)
	claims, flow, err := s.OIDC.Complete(r.Context(), r, code, state)
	if err != nil {
		var fe *oidc.FlowError
		if errors.As(err, &fe) {
			s.Log.Warn("oidc callback failed", "code", fe.Code, "err", fe.Err)
			s.redirectToLogin(w, r, fe.Code)
			return
		}
		s.writeError(w, r, err)
		return
	}
	sess, reason, err := s.Auth.OIDCLogin(r.Context(), claims, flow.Invite, clientMeta(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if reason != "" {
		s.redirectToLogin(w, r, reason)
		return
	}
	s.setSessionCookie(w, sess.Token, sess.ExpiresAt)
	http.Redirect(w, r, s.Config.PublicURL+oidc.SafeNext(flow.Next), http.StatusFound)
}

func (s *Server) redirectToLogin(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, s.Config.PublicURL+"/login?error="+url.QueryEscape(code), http.StatusFound)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
