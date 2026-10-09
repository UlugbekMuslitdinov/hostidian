package oidc

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	gooidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"hostidian/backend/internal/config"
)

const (
	// CookieName holds the signed, short-lived login-flow state between /login and /callback.
	CookieName = "hostidian_oidc"
	// cookiePath restricts the cookie to the OIDC endpoints.
	cookiePath = "/api/auth/oidc"
	stateTTL   = 10 * time.Minute
)

// Flow is what the login request left in the state cookie.
type Flow struct {
	Invite string
	Next   string
}

// FlowError is a failure of the protocol itself; Code ends up in /login?error=<code>.
type FlowError struct {
	Code string
	Err  error
}

func (e *FlowError) Error() string { return "oidc " + e.Code + ": " + e.Err.Error() }
func (e *FlowError) Unwrap() error { return e.Err }

func flowErr(code string, err error) *FlowError { return &FlowError{Code: code, Err: err} }

// Provider performs the authorization-code flow with PKCE, state and nonce against one issuer.
type Provider struct {
	cfg    config.OIDC
	key    []byte
	secure bool
	client *http.Client // optional, for tests
	now    func() time.Time

	mu       sync.Mutex
	provider *gooidc.Provider
}

// New creates a Provider. appSecret signs the state cookie; secure sets the cookie's Secure flag.
// httpClient may be nil.
func New(cfg config.OIDC, appSecret string, secure bool, httpClient *http.Client) *Provider {
	sum := sha256.Sum256([]byte("hostidian/oidc-state/v1\x00" + appSecret))
	return &Provider{cfg: cfg, key: sum[:], secure: secure, client: httpClient, now: time.Now}
}

// Enabled reports whether OIDC is configured at all.
func (p *Provider) Enabled() bool { return p != nil && p.cfg.Enabled() }

// Name is the login-button label.
func (p *Provider) Name() string { return p.cfg.Name }

func (p *Provider) ctx(ctx context.Context) context.Context {
	if p.client != nil {
		return gooidc.ClientContext(ctx, p.client)
	}
	return ctx
}

// discover lazily performs OIDC discovery so a provider outage at start-up does not stop the API.
func (p *Provider) discover(ctx context.Context) (*gooidc.Provider, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.provider != nil {
		return p.provider, nil
	}
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	prov, err := gooidc.NewProvider(p.ctx(dctx), p.cfg.IssuerURL)
	if err != nil {
		return nil, err
	}
	p.provider = prov
	return prov, nil
}

func (p *Provider) oauth(prov *gooidc.Provider) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     p.cfg.ClientID,
		ClientSecret: p.cfg.ClientSecret,
		Endpoint:     prov.Endpoint(),
		RedirectURL:  p.cfg.RedirectURL,
		Scopes:       []string{gooidc.ScopeOpenID, "email", "profile"},
	}
}

// Begin starts a login: it returns the provider URL to redirect to and the state cookie to set.
func (p *Provider) Begin(ctx context.Context, invite, next string) (string, *http.Cookie, error) {
	prov, err := p.discover(ctx)
	if err != nil {
		return "", nil, flowErr("oidc_unavailable", err)
	}
	state, err := randomString()
	if err != nil {
		return "", nil, err
	}
	nonce, err := randomString()
	if err != nil {
		return "", nil, err
	}
	verifier := oauth2.GenerateVerifier()

	sealed, err := p.seal(statePayload{
		State: state, Nonce: nonce, Verifier: verifier, Invite: invite, Next: SafeNext(next),
		Expires: p.now().Add(stateTTL).Unix(),
	})
	if err != nil {
		return "", nil, err
	}
	authURL := p.oauth(prov).AuthCodeURL(state,
		oauth2.S256ChallengeOption(verifier),
		gooidc.Nonce(nonce),
	)
	return authURL, p.cookie(sealed, int(stateTTL.Seconds())), nil
}

// ClearCookie expires the state cookie.
func (p *Provider) ClearCookie() *http.Cookie { return p.cookie("", -1) }

func (p *Provider) cookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name: CookieName, Value: value, Path: cookiePath, MaxAge: maxAge,
		HttpOnly: true, Secure: p.secure, SameSite: http.SameSiteLaxMode,
	}
}

// Complete finishes a login: it checks the state cookie against the `state` query parameter,
// exchanges the code (with the PKCE verifier) and verifies the ID token including its nonce.
func (p *Provider) Complete(ctx context.Context, r *http.Request, code, state string) (Claims, Flow, error) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return Claims{}, Flow{}, flowErr("state_invalid", errors.New("missing state cookie"))
	}
	st, err := p.open(c.Value)
	if err != nil {
		return Claims{}, Flow{}, flowErr("state_invalid", err)
	}
	if state == "" || !hmac.Equal([]byte(state), []byte(st.State)) {
		return Claims{}, Flow{}, flowErr("state_invalid", errors.New("state mismatch"))
	}
	flow := Flow{Invite: st.Invite, Next: SafeNext(st.Next)}
	if code == "" {
		return Claims{}, flow, flowErr("exchange_failed", errors.New("missing code"))
	}

	prov, err := p.discover(ctx)
	if err != nil {
		return Claims{}, flow, flowErr("oidc_unavailable", err)
	}
	exchCtx, cancel := context.WithTimeout(p.ctx(ctx), 15*time.Second)
	defer cancel()
	tok, err := p.oauth(prov).Exchange(exchCtx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return Claims{}, flow, flowErr("exchange_failed", err)
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		return Claims{}, flow, flowErr("token_invalid", errors.New("no id_token in response"))
	}
	idTok, err := prov.Verifier(&gooidc.Config{ClientID: p.cfg.ClientID}).Verify(exchCtx, rawID)
	if err != nil {
		return Claims{}, flow, flowErr("token_invalid", err)
	}
	if !hmac.Equal([]byte(idTok.Nonce), []byte(st.Nonce)) {
		return Claims{}, flow, flowErr("token_invalid", errors.New("nonce mismatch"))
	}
	var raw struct {
		Email             string `json:"email"`
		EmailVerified     any    `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idTok.Claims(&raw); err != nil {
		return Claims{}, flow, flowErr("token_invalid", err)
	}
	name := strings.TrimSpace(raw.Name)
	if name == "" {
		name = strings.TrimSpace(raw.PreferredUsername)
	}
	return Claims{
		Issuer:        idTok.Issuer,
		Subject:       idTok.Subject,
		Email:         strings.TrimSpace(raw.Email),
		EmailVerified: truthy(raw.EmailVerified),
		Name:          name,
	}, flow, nil
}

// truthy accepts both JSON booleans and the "true" strings some providers send.
func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true")
	}
	return false
}

type statePayload struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Invite   string `json:"i,omitempty"`
	Next     string `json:"x,omitempty"`
	Expires  int64  `json:"e"`
}

func (p *Provider) seal(s statePayload) (string, error) {
	body, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, p.key)
	mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (p *Provider) open(value string) (statePayload, error) {
	var s statePayload
	bodyB64, sigB64, ok := strings.Cut(value, ".")
	if !ok {
		return s, errors.New("malformed state cookie")
	}
	body, err1 := base64.RawURLEncoding.DecodeString(bodyB64)
	sig, err2 := base64.RawURLEncoding.DecodeString(sigB64)
	if err1 != nil || err2 != nil {
		return s, errors.New("malformed state cookie")
	}
	mac := hmac.New(sha256.New, p.key)
	mac.Write(body)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return s, errors.New("bad state signature")
	}
	if err := json.Unmarshal(body, &s); err != nil {
		return s, errors.New("malformed state payload")
	}
	if p.now().Unix() > s.Expires {
		return s, errors.New("state expired")
	}
	return s, nil
}

func randomString() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SafeNext reduces a user-supplied return path to a same-origin relative path ("/…"), defaulting to
// "/". It rejects absolute URLs, protocol-relative URLs ("//host"), backslashes and control
// characters (browsers strip tabs/newlines, which could turn "/\t/evil" into "//evil").
func SafeNext(next string) string {
	if next == "" || len(next) > 2048 || next[0] != '/' || strings.HasPrefix(next, "//") {
		return "/"
	}
	for _, r := range next {
		if r < 0x20 || r == 0x7f || r == '\\' {
			return "/"
		}
	}
	u, err := url.Parse(next)
	if err != nil || u.IsAbs() || u.Host != "" || u.User != nil {
		return "/"
	}
	return next
}
