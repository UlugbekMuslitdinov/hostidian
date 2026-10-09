package httpapi_test

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"hostidian/backend/internal/oidc"
)

// fakeIdP is a tiny in-process OpenID provider: discovery, JWKS, authorize (auto-approves with the
// claims set by the test), and a token endpoint that enforces PKCE and the client secret.
type fakeIdP struct {
	t      *testing.T
	srv    *httptest.Server
	key    *rsa.PrivateKey
	mu     sync.Mutex
	claims map[string]any // claims of the next login (sub, email, email_verified, name)
	codes  map[string]pending
	// breakNonce makes the next ID token carry a wrong nonce.
	breakNonce bool
	// lastAuthorize is the query of the most recent authorization request.
	lastAuthorize url.Values
}

type pending struct {
	challenge, nonce string
	claims           map[string]any
	breakNonce       bool
}

func newFakeIdP(t *testing.T) *fakeIdP {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{t: t, key: key, codes: map[string]pending{}}
	mux := http.NewServeMux()
	jsonHandler := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json") // oauth2 picks its parser from this
			h(w, r)
		}
	}
	mux.HandleFunc("/.well-known/openid-configuration", jsonHandler(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize", "token_endpoint": f.srv.URL + "/token",
			"jwks_uri": f.srv.URL + "/jwks", "response_types_supported": []string{"code"},
			"subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	}))
	mux.HandleFunc("/jwks", jsonHandler(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f.mu.Lock()
		defer f.mu.Unlock()
		f.lastAuthorize = q
		code := randomHex(t)
		f.codes[code] = pending{challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), claims: f.claims, breakNonce: f.breakNonce}
		redirect := q.Get("redirect_uri") + "?code=" + code + "&state=" + url.QueryEscape(q.Get("state"))
		http.Redirect(w, r, redirect, http.StatusFound)
	})
	mux.HandleFunc("/token", jsonHandler(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		p, ok := f.codes[r.Form.Get("code")]
		delete(f.codes, r.Form.Get("code")) // single use
		f.mu.Unlock()
		id, secret, hasBasic := r.BasicAuth()
		if !hasBasic {
			id, secret = r.Form.Get("client_id"), r.Form.Get("client_secret")
		}
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || id != "client-id" || secret != "client-secret" || base64.RawURLEncoding.EncodeToString(sum[:]) != p.challenge {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
			return
		}
		nonce := p.nonce
		if p.breakNonce {
			nonce = "not-the-nonce"
		}
		claims := jwt.MapClaims{"iss": f.srv.URL, "aud": "client-id", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(), "nonce": nonce}
		for k, v := range p.claims {
			claims[k] = v
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = "k1"
		signed, err := tok.SignedString(key)
		if err != nil {
			t.Error(err)
		}
		json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 3600, "id_token": signed})
	}))
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func randomHex(t *testing.T) string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func (f *fakeIdP) setClaims(c map[string]any) {
	f.mu.Lock()
	f.claims = c
	f.mu.Unlock()
}

func oidcEnv(t *testing.T, idp *fakeIdP) *env {
	return newEnv(t, func(o *envOpts) {
		o.configure = func(v map[string]string) {
			v["OIDC_ISSUER_URL"] = idp.srv.URL
			v["OIDC_CLIENT_ID"] = "client-id"
			v["OIDC_CLIENT_SECRET"] = "client-secret"
			v["OIDC_NAME"] = "Acme SSO"
		}
	})
}

// oidcLogin walks the whole browser flow and returns the final redirect target plus the session cookie.
func (e *env) oidcLogin(idp *fakeIdP, query string, mutateCookie func(string) string) (target string, session string) {
	e.t.Helper()
	c := e.client()
	login := c.request("GET", "/auth/oidc/login"+query, nil)
	if login.status != 302 {
		e.t.Fatalf("login status = %d: %s", login.status, login.body)
	}
	var stateCookie string
	for _, ck := range login.cookies {
		if ck.Name == oidc.CookieName {
			stateCookie = ck.Value
		}
	}
	if stateCookie == "" {
		e.t.Fatal("no OIDC state cookie")
	}
	// the browser goes to the provider, which bounces back to the callback
	res, err := http.DefaultTransport.RoundTrip(mustReq(e.t, login.header.Get("Location")))
	if err != nil {
		e.t.Fatal(err)
	}
	res.Body.Close()
	cb, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		e.t.Fatal(err)
	}
	if mutateCookie != nil {
		stateCookie = mutateCookie(stateCookie)
	}
	r := c.request("GET", "/auth/oidc/callback?"+cb.RawQuery, nil, func(r *http.Request) {
		r.Header.Add("Cookie", oidc.CookieName+"="+stateCookie)
	})
	if r.status != 302 {
		e.t.Fatalf("callback status = %d: %s", r.status, r.body)
	}
	return r.header.Get("Location"), c.cookie
}

func mustReq(t *testing.T, u string) *http.Request {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestOIDCDisabledByDefault(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	c.mustStatus(c.get("/auth/oidc/login"), 404)
	c.mustStatus(c.get("/auth/oidc/callback?code=x&state=y"), 404)
}

func TestOIDCLoginFlow(t *testing.T) {
	idp := newFakeIdP(t)
	e := oidcEnv(t, idp)
	admin, ws := e.setupAdmin()

	info := e.client().get("/instance/info").m()["oidc"].(map[string]any)
	if info["enabled"] != true || info["name"] != "Acme SSO" {
		t.Fatalf("oidc info = %v", info)
	}

	// 1. closed instance + unknown identity -> refused
	idp.setClaims(map[string]any{"sub": "sub-ada", "email": "ada@example.com", "email_verified": true, "name": "Ada"})
	target, session := e.oidcLogin(idp, "", nil)
	if target != publicURL+"/login?error=signup_disabled" || session != "" {
		t.Fatalf("closed instance: target=%q session=%q", target, session)
	}
	// the authorization request carried PKCE (S256), state, nonce and our redirect URI
	q := idp.lastAuthorize
	if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("state") == "" || q.Get("nonce") == "" ||
		q.Get("redirect_uri") != publicURL+"/api/auth/oidc/callback" || q.Get("response_type") != "code" || q.Get("client_id") != "client-id" ||
		!strings.Contains(q.Get("scope"), "openid") {
		t.Fatalf("authorization request = %v", q)
	}

	// 2. open signup creates the account; `next` is honoured when it is a relative path
	admin.mustStatus(admin.patch("/admin/settings", map[string]any{"allowOpenSignup": true}), 200)
	target, session = e.oidcLogin(idp, "?next=/w/acme/p/1", nil)
	if target != publicURL+"/w/acme/p/1" || session == "" {
		t.Fatalf("open signup: target=%q session=%q", target, session)
	}
	ada := &client{e: e, origin: publicURL, cookie: session}
	u := ada.mustStatus(ada.get("/auth/me"), 200).m()["user"].(map[string]any)
	if u["email"] != "ada@example.com" || u["name"] != "Ada" || u["hasPassword"] != false || u["isInstanceAdmin"] != false {
		t.Fatalf("oidc user = %v", u)
	}
	// password login is impossible for OIDC-only accounts
	nopw := e.client()
	nopw.mustStatus(nopw.post("/auth/login", map[string]any{"email": "ada@example.com", "password": testPassword}), 401)

	// 3. the same subject logs in again (matched by (issuer, subject), even if the email changed)
	idp.setClaims(map[string]any{"sub": "sub-ada", "email": "ada.new@example.com", "email_verified": true})
	target, session = e.oidcLogin(idp, "", nil)
	if target != publicURL+"/" || session == "" {
		t.Fatalf("relogin: target=%q session=%q", target, session)
	}
	var users int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM users`).Scan(&users)
	if users != 2 {
		t.Fatalf("users = %d, want 2 (no duplicates)", users)
	}

	// 4. open redirects are impossible
	for _, next := range []string{"//evil.example", "https://evil.example", `/\evil.example`, "javascript:alert(1)"} {
		target, _ = e.oidcLogin(idp, "?next="+url.QueryEscape(next), nil)
		if target != publicURL+"/" {
			t.Fatalf("next=%q redirected to %q", next, target)
		}
	}

	// 5. linking to an existing password account: only with a verified email
	idp.setClaims(map[string]any{"sub": "sub-admin-unverified", "email": "admin@example.com", "email_verified": false})
	if target, session = e.oidcLogin(idp, "", nil); target != publicURL+"/login?error=email_unverified" || session != "" {
		t.Fatalf("unverified email must not take over an account: %q %q", target, session)
	}
	idp.setClaims(map[string]any{"sub": "sub-admin", "email": "admin@example.com", "email_verified": true})
	if target, session = e.oidcLogin(idp, "", nil); target != publicURL+"/" || session == "" {
		t.Fatalf("verified email should link: %q %q", target, session)
	}
	linked := &client{e: e, origin: publicURL, cookie: session}
	if linked.get("/auth/me").m()["user"].(map[string]any)["isInstanceAdmin"] != true {
		t.Fatal("linking must reach the existing admin account")
	}
	var identities int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM oidc_identities`).Scan(&identities)
	if identities != 2 {
		t.Fatalf("identities = %d", identities)
	}

	// 6. disabled accounts are refused
	adaID := bobID(t, e, "ada@example.com")
	admin.mustStatus(admin.patch("/admin/users/"+adaID.String(), map[string]any{"disabled": true}), 200)
	idp.setClaims(map[string]any{"sub": "sub-ada", "email": "ada@example.com", "email_verified": true})
	if target, session = e.oidcLogin(idp, "", nil); target != publicURL+"/login?error=account_disabled" || session != "" {
		t.Fatalf("disabled: %q %q", target, session)
	}

	// 7. invites: closed instance + invite token creates the account and joins the workspace
	admin.mustStatus(admin.patch("/admin/settings", map[string]any{"allowOpenSignup": false}), 200)
	inv := admin.invite(ws, "member", "")
	idp.setClaims(map[string]any{"sub": "sub-bob", "email": "bob@example.com", "email_verified": true, "name": "Bob"})
	target, session = e.oidcLogin(idp, "?invite="+inv, nil)
	if target != publicURL+"/" || session == "" {
		t.Fatalf("invite signup: %q %q", target, session)
	}
	bob := &client{e: e, origin: publicURL, cookie: session}
	if w := bob.get("/auth/me").m()["workspaces"].([]any); len(w) != 1 || w[0].(map[string]any)["role"] != "member" {
		t.Fatalf("invite did not add the workspace: %v", w)
	}
	// ... the invite is consumed, and an e-mail restricted one demands that e-mail
	if target, _ = e.oidcLogin(idp, "?invite="+inv, nil); target != publicURL+"/" { // bob exists now: plain login
		t.Fatalf("bob relogin: %q", target)
	}
	restricted := admin.invite(ws, "guest", "carol@example.com")
	idp.setClaims(map[string]any{"sub": "sub-dave", "email": "dave@example.com", "email_verified": true})
	if target, _ = e.oidcLogin(idp, "?invite="+restricted, nil); target != publicURL+"/login?error=invite_email_mismatch" {
		t.Fatalf("restricted invite: %q", target)
	}
	idp.setClaims(map[string]any{"sub": "sub-carol", "email": "carol@example.com", "email_verified": true})
	if target, session = e.oidcLogin(idp, "?invite="+restricted, nil); target != publicURL+"/" || session == "" {
		t.Fatalf("restricted invite, right email: %q %q", target, session)
	}
}

func TestOIDCFlowProtections(t *testing.T) {
	idp := newFakeIdP(t)
	e := oidcEnv(t, idp)
	admin, _ := e.setupAdmin()
	admin.mustStatus(admin.patch("/admin/settings", map[string]any{"allowOpenSignup": true}), 200)
	idp.setClaims(map[string]any{"sub": "s1", "email": "x@example.com", "email_verified": true})

	// a tampered or foreign state cookie is rejected
	target, session := e.oidcLogin(idp, "", func(v string) string { return v[:len(v)-3] + "AAA" })
	if target != publicURL+"/login?error=state_invalid" || session != "" {
		t.Fatalf("tampered cookie: %q %q", target, session)
	}
	// the callback without any cookie
	c := e.client()
	r := c.get("/auth/oidc/callback?code=abc&state=def")
	c.mustStatus(r, 302)
	if r.header.Get("Location") != publicURL+"/login?error=state_invalid" {
		t.Fatalf("no cookie: %s", r.header.Get("Location"))
	}
	// a state that does not match the cookie (login CSRF)
	login := c.get("/auth/oidc/login")
	var cookie string
	for _, ck := range login.cookies {
		if ck.Name == oidc.CookieName {
			cookie = ck.Value
		}
	}
	r = c.request("GET", "/auth/oidc/callback?code=abc&state=forged", nil, func(r *http.Request) { r.Header.Set("Cookie", oidc.CookieName+"="+cookie) })
	if r.header.Get("Location") != publicURL+"/login?error=state_invalid" {
		t.Fatalf("forged state: %s", r.header.Get("Location"))
	}
	// the provider reports an error (user denied consent)
	r = c.get("/auth/oidc/callback?error=access_denied")
	if r.header.Get("Location") != publicURL+"/login?error=oidc_denied" {
		t.Fatalf("provider error: %s", r.header.Get("Location"))
	}
	// the ID token's nonce must match
	idp.breakNonce = true
	target, session = e.oidcLogin(idp, "", nil)
	idp.breakNonce = false
	if target != publicURL+"/login?error=token_invalid" || session != "" {
		t.Fatalf("nonce mismatch: %q %q", target, session)
	}
	// a replayed authorization code is rejected by the provider
	c2 := e.client()
	l := c2.get("/auth/oidc/login")
	for _, ck := range l.cookies {
		if ck.Name == oidc.CookieName {
			cookie = ck.Value
		}
	}
	res, _ := http.DefaultTransport.RoundTrip(mustReq(t, l.header.Get("Location")))
	res.Body.Close()
	cb, _ := url.Parse(res.Header.Get("Location"))
	withCookie := func(r *http.Request) { r.Header.Set("Cookie", oidc.CookieName+"="+cookie) }
	first := c2.request("GET", "/auth/oidc/callback?"+cb.RawQuery, nil, withCookie)
	second := c2.request("GET", "/auth/oidc/callback?"+cb.RawQuery, nil, withCookie)
	if first.header.Get("Location") != publicURL+"/" || second.header.Get("Location") != publicURL+"/login?error=exchange_failed" {
		t.Fatalf("replay: first=%s second=%s", first.header.Get("Location"), second.header.Get("Location"))
	}
	// the state cookie is cleared by the callback
	cleared := false
	for _, ck := range first.cookies {
		if ck.Name == oidc.CookieName && ck.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("state cookie not cleared after the callback")
	}
}
