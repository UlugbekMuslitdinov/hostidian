package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"time"

	"hostidian/backend/internal/auth"
)

// sessionCookie returns the raw session token from the request.
func sessionCookie(r *http.Request) (string, bool) {
	c, err := r.Cookie(auth.CookieName)
	if err != nil || c.Value == "" {
		return "", false
	}
	return c.Value, true
}

func (s *Server) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: token, Path: "/",
		Expires: expires.UTC(), MaxAge: int(time.Until(expires).Seconds()),
		HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.Config.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
}

// constantTimeEqual compares secrets of possibly different length without leaking where they differ.
func constantTimeEqual(a, b string) bool {
	ha, hb := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}
