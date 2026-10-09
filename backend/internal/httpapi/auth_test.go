package httpapi_test

import (
	"crypto/sha256"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/auth"
	"hostidian/backend/internal/collabclient"
)

func TestSetupLoginMeLogout(t *testing.T) {
	e := newEnv(t)
	c := e.client()

	info := c.get("/instance/info")
	c.mustStatus(info, 200)
	if m := info.m(); m["needsSetup"] != true || m["allowOpenSignup"] != false || m["instanceName"] != "Hostidian" {
		t.Fatalf("unexpected instance info: %v", m)
	}
	if oidc := info.m()["oidc"].(map[string]any); oidc["enabled"] != false {
		t.Fatalf("oidc should be disabled: %v", oidc)
	}

	// invalid inputs are validated before anything is created
	c.mustStatus(c.post("/setup", map[string]any{"name": "A", "email": "not-an-email", "password": testPassword}), 422)
	c.mustStatus(c.post("/setup", map[string]any{"name": "A", "email": "a@example.com", "password": "short"}), 422)

	r := c.mustStatus(c.post("/setup", map[string]any{
		"name": "Ada", "email": "Ada@Example.com", "password": testPassword, "workspaceName": "Lovelace Labs",
	}), 201)
	me := r.m()
	user := me["user"].(map[string]any)
	if user["email"] != "ada@example.com" || user["isInstanceAdmin"] != true || user["hasPassword"] != true {
		t.Fatalf("unexpected user: %v", user)
	}
	if _, leaked := user["passwordHash"]; leaked {
		t.Fatal("password hash leaked")
	}
	ws := me["workspaces"].([]any)
	if len(ws) != 1 || ws[0].(map[string]any)["role"] != "owner" ||
		ws[0].(map[string]any)["workspace"].(map[string]any)["slug"] != "lovelace-labs" {
		t.Fatalf("default workspace missing or wrong: %v", ws)
	}

	// session cookie attributes (conventions §2)
	var cookie *http.Cookie
	for _, ck := range r.cookies {
		if ck.Name == auth.CookieName {
			cookie = ck
		}
	}
	if cookie == nil {
		t.Fatal("no session cookie set")
	}
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.Secure {
		t.Fatalf("cookie attributes: %+v (Secure must be false for an http PUBLIC_URL)", cookie)
	}
	if cookie.MaxAge < 29*24*3600 {
		t.Fatalf("cookie max-age = %d, want about 30 days", cookie.MaxAge)
	}
	// only the SHA-256 of the token is stored
	var stored []byte
	if err := e.pool.QueryRow(ctx(), `SELECT token_hash FROM sessions`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if want := sha256.Sum256([]byte(cookie.Value)); string(stored) != string(want[:]) {
		t.Fatal("sessions.token_hash is not SHA-256(token)")
	}

	c.mustStatus(c.get("/auth/me"), 200)
	if e.client().get("/auth/me").status != 401 {
		t.Fatal("me without a session must be 401")
	}

	// setup is a one-shot
	c.mustStatus(c.post("/setup", map[string]any{"name": "Eve", "email": "eve@example.com", "password": testPassword}), 409)
	if m := c.get("/instance/info").m(); m["needsSetup"] != false {
		t.Fatalf("needsSetup should be false: %v", m)
	}

	c.mustStatus(c.post("/auth/logout", nil), 204)
	if c.get("/auth/me").status != 401 {
		t.Fatal("session must be gone after logout")
	}
	var n int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM sessions`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d sessions left after logout", n)
	}

	// login: wrong password / unknown user answer the same way
	bad := c.post("/auth/login", map[string]any{"email": "ada@example.com", "password": "wrong password!"})
	c.mustStatus(bad, 401)
	if bad.errCode() != "unauthorized" {
		t.Fatalf("code = %s", bad.errCode())
	}
	unknown := c.post("/auth/login", map[string]any{"email": "nobody@example.com", "password": "wrong password!"})
	c.mustStatus(unknown, 401)
	if string(bad.body) != string(unknown.body) {
		t.Fatalf("login errors differ, leaking account existence: %s vs %s", bad.body, unknown.body)
	}
	c.mustStatus(c.post("/auth/login", map[string]any{"email": "ADA@example.com", "password": testPassword}), 200)
	c.mustStatus(c.get("/auth/me"), 200)
}

func TestSecureCookieFollowsPublicURL(t *testing.T) {
	e := newEnv(t, func(o *envOpts) {
		o.configure = func(v map[string]string) { v["PUBLIC_URL"] = "https://notes.test" }
	})
	c := e.client()
	c.origin = "https://notes.test"
	r := c.mustStatus(c.post("/setup", map[string]any{"name": "A", "email": "a@example.com", "password": testPassword}), 201)
	for _, ck := range r.cookies {
		if ck.Name == auth.CookieName && !ck.Secure {
			t.Fatal("cookie must be Secure when PUBLIC_URL is https")
		}
	}
	if e.cfg.CollabPublicURL != "wss://notes.test/collab" {
		t.Fatalf("derived collab url = %q", e.cfg.CollabPublicURL)
	}
}

func TestInviteRegistration(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()

	// registration is closed by default
	anon := e.client()
	r := anon.post("/auth/register", map[string]any{"name": "Bob", "email": "bob@example.com", "password": testPassword})
	anon.mustStatus(r, 403)

	token := admin.invite(ws, "member", "bob@example.com")
	info := anon.mustStatus(anon.get("/auth/invites/"+token), 200).m()
	if info["workspaceName"] != "Acme" || info["role"] != "member" || info["email"] != "bob@example.com" {
		t.Fatalf("invite info = %v", info)
	}
	anon.mustStatus(anon.get("/auth/invites/does-not-exist"), 404)

	reg := func(email, tok string) *resp {
		return anon.post("/auth/register", map[string]any{"name": "Bob", "email": email, "password": testPassword, "inviteToken": tok})
	}
	anon.mustStatus(reg("eve@example.com", token), 403) // invite is restricted to bob's address
	anon.mustStatus(reg("bob@example.com", "bogus"), 403)
	anon.mustStatus(anon.post("/auth/register", map[string]any{"name": "Bob", "email": "bob@example.com", "password": "short", "inviteToken": token}), 422)

	me := anon.mustStatus(reg("bob@example.com", token), 201).m()
	w := me["workspaces"].([]any)
	if len(w) != 1 || w[0].(map[string]any)["role"] != "member" {
		t.Fatalf("invite did not add the member: %v", w)
	}
	if me["user"].(map[string]any)["isInstanceAdmin"] != false {
		t.Fatal("registered users are never instance admins")
	}
	anon.mustStatus(anon.get("/auth/me"), 200) // registration logs in

	// the invite is consumed
	e.client().mustStatus(e.client().get("/auth/invites/"+token), 404)
	other := e.client()
	other.mustStatus(other.post("/auth/register", map[string]any{"name": "Bob2", "email": "bob2@example.com", "password": testPassword, "inviteToken": token}), 403)

	// duplicate email -> 409 (with a fresh invite)
	token2 := admin.invite(ws, "guest", "")
	dup := e.client()
	dup.mustStatus(dup.post("/auth/register", map[string]any{"name": "Bob", "email": "BOB@example.com", "password": testPassword, "inviteToken": token2}), 409)

	// expired invites are refused
	token3 := admin.invite(ws, "member", "")
	if _, err := e.pool.Exec(ctx(), `UPDATE invites SET expires_at = now() - interval '1 minute' WHERE token = $1`, token3); err != nil {
		t.Fatal(err)
	}
	exp := e.client()
	exp.mustStatus(exp.post("/auth/register", map[string]any{"name": "Cy", "email": "cy@example.com", "password": testPassword, "inviteToken": token3}), 403)
	exp.mustStatus(exp.get("/auth/invites/"+token3), 404)
}

func TestOpenSignupToggle(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	body := map[string]any{"name": "Open", "email": "open@example.com", "password": testPassword}

	anon := e.client()
	anon.mustStatus(anon.post("/auth/register", body), 403)

	s := admin.mustStatus(admin.patch("/admin/settings", map[string]any{"allowOpenSignup": true, "instanceName": "Acme Notes"}), 200).m()
	if s["allowOpenSignup"] != true || s["instanceName"] != "Acme Notes" || s["allowWorkspaceCreation"] != true {
		t.Fatalf("settings = %v", s)
	}
	if got := anon.get("/instance/info").m(); got["allowOpenSignup"] != true || got["instanceName"] != "Acme Notes" {
		t.Fatalf("public info out of date: %v", got)
	}
	me := anon.mustStatus(anon.post("/auth/register", body), 201).m()
	if len(me["workspaces"].([]any)) != 0 {
		t.Fatal("open signup must not add the user to any workspace")
	}

	// the new user can accept an invite afterwards
	token := admin.invite(ws, "guest", "")
	joined := anon.mustStatus(anon.post("/auth/invites/"+token, nil), 200).m()
	if w := joined["workspaces"].([]any); len(w) != 1 || w[0].(map[string]any)["role"] != "guest" {
		t.Fatalf("accept invite: %v", w)
	}
	anon.mustStatus(anon.post("/auth/invites/"+token, nil), 404) // consumed
	// already a member -> 409 and the invite stays usable
	token2 := admin.invite(ws, "admin", "")
	anon.mustStatus(anon.post("/auth/invites/"+token2, nil), 409)
	anon.mustStatus(anon.get("/auth/invites/"+token2), 200)
	// invites restricted to another address look missing
	token3 := admin.invite(ws, "member", "someone-else@example.com")
	other, _ := e.newUser(admin, ws, "member", "Zed")
	other.mustStatus(other.post("/auth/invites/"+token3, nil), 404)

	admin.mustStatus(admin.patch("/admin/settings", map[string]any{"allowOpenSignup": false}), 200)
	closed := e.client()
	closed.mustStatus(closed.post("/auth/register", map[string]any{"name": "Late", "email": "late@example.com", "password": testPassword}), 403)

	// validation of settings
	admin.mustStatus(admin.patch("/admin/settings", map[string]any{"instanceName": ""}), 422)
	nonAdmin := other
	nonAdmin.mustStatus(nonAdmin.get("/admin/settings"), 403)
	nonAdmin.mustStatus(nonAdmin.patch("/admin/settings", map[string]any{"allowOpenSignup": true}), 403)
}

func TestLoginRateLimit(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin()
	_ = admin
	c := e.client()
	wrong := map[string]any{"email": "admin@example.com", "password": "definitely wrong"}
	for i := 0; i < 10; i++ {
		c.mustStatus(c.post("/auth/login", wrong), 401)
	}
	limited := c.post("/auth/login", wrong)
	c.mustStatus(limited, 429)
	if limited.errCode() != "rate_limited" || limited.header.Get("Retry-After") == "" {
		t.Fatalf("code = %s, Retry-After = %q", limited.errCode(), limited.header.Get("Retry-After"))
	}
	// even the right password is refused while limited, and another email is unaffected
	c.mustStatus(c.post("/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}), 429)
	c.mustStatus(c.post("/auth/login", map[string]any{"email": "other@example.com", "password": "definitely wrong"}), 401)
	// the window refills: 10 attempts / 15 minutes
	e.clock.Advance(16 * time.Minute)
	c.mustStatus(c.post("/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}), 200)

	// a successful login resets the counter
	c2 := e.client()
	for i := 0; i < 9; i++ {
		c2.mustStatus(c2.post("/auth/login", wrong), 401)
	}
	c2.mustStatus(c2.post("/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}), 200)
	for i := 0; i < 10; i++ {
		c2.mustStatus(c2.post("/auth/login", wrong), 401)
	}
	c2.mustStatus(c2.post("/auth/login", wrong), 429)
}

func TestRegisterRateLimit(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	c := e.client()
	body := map[string]any{"name": "X", "email": "x@example.com", "password": testPassword, "inviteToken": "nope"}
	for i := 0; i < 10; i++ {
		c.mustStatus(c.post("/auth/register", body), 403)
	}
	c.mustStatus(c.post("/auth/register", body), 429)
}

func TestDisabledUser(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	bob.mustStatus(bob.get("/auth/me"), 200)

	users := admin.mustStatus(admin.get("/admin/users"), 200).list()
	if len(users) != 2 {
		t.Fatalf("admin list = %v", users)
	}

	e.collab.reset()
	upd := admin.mustStatus(admin.patch("/admin/users/"+bobID.String(), map[string]any{"disabled": true}), 200).m()
	if upd["disabledAt"] == nil {
		t.Fatalf("disabledAt not set: %v", upd)
	}
	if bob.get("/auth/me").status != 401 {
		t.Fatal("a disabled user's session must stop working")
	}
	fresh := e.client()
	fresh.mustStatus(fresh.post("/auth/login", map[string]any{"email": "bob@example.com", "password": testPassword}), 401)
	found := false
	for _, call := range e.collab.snapshot() {
		if call.UserID == bobID {
			found = true
		}
	}
	if !found {
		t.Fatalf("collab sockets of the disabled user were not closed: %+v", e.collab.snapshot())
	}

	admin.mustStatus(admin.patch("/admin/users/"+bobID.String(), map[string]any{"disabled": false}), 200)
	fresh.mustStatus(fresh.post("/auth/login", map[string]any{"email": "bob@example.com", "password": testPassword}), 200)
	admin.mustStatus(admin.patch("/admin/users/"+uuid.NewString(), map[string]any{"disabled": true}), 404)
	bob.mustStatus(bob.get("/admin/users"), 401) // his old session was revoked when he was disabled
	bob.mustStatus(bob.post("/auth/login", map[string]any{"email": "bob@example.com", "password": testPassword}), 200)
	bob.mustStatus(bob.get("/admin/users"), 403)
}

func TestInstanceAdminInvariants(t *testing.T) {
	e := newEnv(t)
	a, ws := e.setupAdmin()
	adminID := uuid.MustParse(a.get("/auth/me").m()["user"].(map[string]any)["id"].(string))
	b, bID := e.newUser(a, ws, "member", "Bob")

	// the only admin can neither disable nor demote themselves
	a.mustStatus(a.patch("/admin/users/"+adminID.String(), map[string]any{"disabled": true}), 409)
	a.mustStatus(a.patch("/admin/users/"+adminID.String(), map[string]any{"isInstanceAdmin": false}), 409)
	b.mustStatus(b.patch("/admin/users/"+adminID.String(), map[string]any{"disabled": true}), 403)

	// promote Bob; now Bob may demote Ada (she is not the last admin) but not himself
	a.mustStatus(a.patch("/admin/users/"+bID.String(), map[string]any{"isInstanceAdmin": true}), 200)
	b.mustStatus(b.patch("/admin/users/"+bID.String(), map[string]any{"isInstanceAdmin": false}), 409)
	b.mustStatus(b.patch("/admin/users/"+adminID.String(), map[string]any{"isInstanceAdmin": false}), 200)
	a.mustStatus(a.get("/admin/users"), 403) // Ada lost the admin console
	b.mustStatus(b.patch("/admin/users/"+bID.String(), map[string]any{"disabled": true}), 409)

	// Bob is the last admin; nobody (but him) could touch him anyway, and he can still manage others.
	b.mustStatus(b.patch("/admin/users/"+adminID.String(), map[string]any{"disabled": true}), 200)
}

func TestOriginCheck(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	pages := "/workspaces/" + ws.String() + "/pages"

	noOrigin := func(r *http.Request) { r.Header.Del("Origin") }
	setOrigin := func(o string) func(*http.Request) {
		return func(r *http.Request) { r.Header.Set("Origin", o) }
	}

	// state-changing request with a session but no Origin -> 403
	r := admin.request("POST", pages, map[string]any{"title": "x"}, noOrigin)
	admin.mustStatus(r, 403)
	if r.errCode() != "forbidden" {
		t.Fatalf("code = %s", r.errCode())
	}
	admin.mustStatus(admin.request("POST", pages, map[string]any{"title": "x"}, setOrigin("http://evil.test")), 403)
	admin.mustStatus(admin.request("POST", pages, map[string]any{"title": "x"}, setOrigin("null")), 403)
	admin.mustStatus(admin.request("POST", pages, map[string]any{"title": "x"}, setOrigin("http://allowed.test")), 201) // ALLOWED_ORIGINS
	admin.mustStatus(admin.request("POST", pages, map[string]any{"title": "y"}, setOrigin(publicURL)), 201)
	admin.mustStatus(admin.request("POST", "/auth/logout", nil, noOrigin), 403)

	// GETs need no Origin, but a foreign one is refused
	admin.mustStatus(admin.request("GET", "/auth/me", nil, noOrigin), 200)
	admin.mustStatus(admin.request("GET", "/auth/me", nil, setOrigin("http://evil.test")), 403)

	// login/setup/register from curl (no Origin, no cookie) are fine; with a cookie they are not
	anon := e.client()
	anon.mustStatus(anon.request("POST", "/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}, noOrigin), 200)
	anon.mustStatus(anon.request("POST", "/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}, noOrigin), 403) // cookie now present
	anon.mustStatus(anon.request("POST", "/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}, setOrigin("http://evil.test")), 403)
	// other mutating endpoints do not get the no-Origin exemption
	fresh := e.client()
	fresh.mustStatus(fresh.request("POST", "/workspaces", map[string]any{"name": "x"}, noOrigin), 403)
}

func TestSessionSlidingExpiry(t *testing.T) {
	e := newEnv(t)
	c, _ := e.setupAdmin()
	token := strings.TrimPrefix(c.cookie, auth.CookieName+"=")
	hash := sha256.Sum256([]byte(token))

	row := func() (seen, expires time.Time) {
		if err := e.pool.QueryRow(ctx(), `SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = $1`, hash[:]).Scan(&seen, &expires); err != nil {
			t.Fatal(err)
		}
		return
	}

	// a request within 5 minutes of the last one does not write
	seen0, exp0 := row()
	r := c.mustStatus(c.get("/auth/me"), 200)
	seen1, exp1 := row()
	if !seen1.Equal(seen0) || !exp1.Equal(exp0) || len(r.cookies) != 0 {
		t.Fatal("session was touched again within the 5 minute window")
	}

	// after 10 idle minutes the next request slides last_seen_at and the 30 day expiry forward
	if _, err := e.pool.Exec(ctx(), `UPDATE sessions SET last_seen_at = now() - interval '10 minutes', expires_at = now() + interval '2 days' WHERE token_hash = $1`, hash[:]); err != nil {
		t.Fatal(err)
	}
	r = c.mustStatus(c.get("/auth/me"), 200)
	seen2, exp2 := row()
	if time.Since(seen2) > time.Minute {
		t.Fatalf("last_seen_at not updated: %v", seen2)
	}
	if d := time.Until(exp2); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Fatalf("expires_at = %v from now, want ~30 days", d)
	}
	refreshed := false
	for _, ck := range r.cookies {
		if ck.Name == auth.CookieName && ck.MaxAge > 29*24*3600 {
			refreshed = true
		}
	}
	if !refreshed {
		t.Fatal("cookie was not re-issued with the new expiry")
	}

	// an expired session is rejected and the stale cookie cleared
	if _, err := e.pool.Exec(ctx(), `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, hash[:]); err != nil {
		t.Fatal(err)
	}
	stale := c.get("/auth/me")
	c.mustStatus(stale, 401)
	if c.cookie != "" {
		t.Fatal("stale cookie should be cleared")
	}
}

func TestSessionsListAndRevoke(t *testing.T) {
	e := newEnv(t)
	c1, _ := e.setupAdmin()
	c2 := e.client()
	c2.mustStatus(c2.request("POST", "/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword},
		func(r *http.Request) { r.Header.Set("User-Agent", "second-device/1.0") }), 200)

	list := c1.mustStatus(c1.get("/auth/sessions"), 200).list()
	if len(list) != 2 {
		t.Fatalf("sessions = %v", list)
	}
	var otherID string
	currents := 0
	for _, s := range list {
		if s["current"] == true {
			currents++
		} else {
			otherID = s["id"].(string)
			if s["userAgent"] != "second-device/1.0" {
				t.Fatalf("user agent = %v", s["userAgent"])
			}
		}
	}
	if currents != 1 || otherID == "" {
		t.Fatalf("expected exactly one current session: %v", list)
	}

	c1.mustStatus(c1.delete("/auth/sessions/"+uuid.NewString()), 404)
	c1.mustStatus(c1.delete("/auth/sessions/"+otherID), 204)
	c2.mustStatus(c2.get("/auth/me"), 401)

	// nobody can revoke somebody else's session
	b, _ := e.newUser(c1, mustWorkspace(t, c1), "member", "Bob")
	bobSessions := b.get("/auth/sessions").list()
	c1.mustStatus(c1.delete("/auth/sessions/"+bobSessions[0]["id"].(string)), 404)
	b.mustStatus(b.get("/auth/me"), 200)
}

func mustWorkspace(t *testing.T, c *client) uuid.UUID {
	t.Helper()
	w := c.get("/workspaces").list()
	return uuid.MustParse(w[0]["workspace"].(map[string]any)["id"].(string))
}

func TestProfileAndPassword(t *testing.T) {
	e := newEnv(t)
	c, ws := e.setupAdmin()
	other := e.client()
	other.mustStatus(other.post("/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}), 200)

	u := c.mustStatus(c.patch("/auth/profile", map[string]any{"name": "  Grace  ", "avatarColor": "#AABBCC"}), 200).m()
	if u["name"] != "Grace" || u["avatarColor"] != "#AABBCC" {
		t.Fatalf("profile = %v", u)
	}
	c.mustStatus(c.patch("/auth/profile", map[string]any{"avatarColor": "red"}), 422)
	c.mustStatus(c.patch("/auth/profile", map[string]any{"name": ""}), 422)

	// wrong / missing current password
	wrong := c.post("/auth/password", map[string]any{"currentPassword": "nope nope nope", "newPassword": "a brand new password"})
	c.mustStatus(wrong, 422)
	if wrong.errCode() != "validation_failed" {
		t.Fatalf("code = %s", wrong.errCode())
	}
	c.mustStatus(c.post("/auth/password", map[string]any{"newPassword": "a brand new password"}), 422)
	c.mustStatus(c.post("/auth/password", map[string]any{"currentPassword": testPassword, "newPassword": "short"}), 422)

	c.mustStatus(c.post("/auth/password", map[string]any{"currentPassword": testPassword, "newPassword": "a brand new password"}), 204)
	c.mustStatus(c.get("/auth/me"), 200)         // the current session survives
	other.mustStatus(other.get("/auth/me"), 401) // other sessions are revoked
	fresh := e.client()
	fresh.mustStatus(fresh.post("/auth/login", map[string]any{"email": "admin@example.com", "password": testPassword}), 401)
	fresh.mustStatus(fresh.post("/auth/login", map[string]any{"email": "admin@example.com", "password": "a brand new password"}), 200)

	// OIDC-only accounts (no password yet) may set one without a current password
	bob, bobID := e.newUser(c, ws, "member", "Bob")
	if _, err := e.pool.Exec(ctx(), `UPDATE users SET password_hash = NULL WHERE id = $1`, bobID); err != nil {
		t.Fatal(err)
	}
	if bob.get("/auth/me").m()["user"].(map[string]any)["hasPassword"] != false {
		t.Fatal("hasPassword should be false")
	}
	bob.mustStatus(bob.post("/auth/password", map[string]any{"newPassword": "bobs very new password"}), 204)
	if bob.get("/auth/me").m()["user"].(map[string]any)["hasPassword"] != true {
		t.Fatal("hasPassword should be true now")
	}
}

func TestPasswordReset(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")

	bob.mustStatus(bob.post("/admin/users/"+bobID.String()+"/reset-link", nil), 403)
	admin.mustStatus(admin.post("/admin/users/"+uuid.NewString()+"/reset-link", nil), 404)
	link := admin.mustStatus(admin.post("/admin/users/"+bobID.String()+"/reset-link", nil), 201).m()
	url := link["url"].(string)
	if !strings.HasPrefix(url, publicURL+"/") {
		t.Fatalf("reset url %q is not built from PUBLIC_URL", url)
	}
	exp, err := time.Parse(time.RFC3339, link["expiresAt"].(string))
	if err != nil || time.Until(exp) < 23*time.Hour || time.Until(exp) > 25*time.Hour {
		t.Fatalf("expiresAt = %v (%v)", link["expiresAt"], err)
	}
	token := url[strings.LastIndex(url, "/")+1:]

	anon := e.client()
	anon.mustStatus(anon.post("/auth/password-reset/confirm", map[string]any{"token": "bogus", "newPassword": "another new password"}), 404)
	anon.mustStatus(anon.post("/auth/password-reset/confirm", map[string]any{"token": token, "newPassword": "short"}), 422)
	anon.mustStatus(anon.post("/auth/password-reset/confirm", map[string]any{"token": token, "newPassword": "another new password"}), 204)
	anon.mustStatus(anon.post("/auth/password-reset/confirm", map[string]any{"token": token, "newPassword": "yet another password"}), 404) // single use

	bob.mustStatus(bob.get("/auth/me"), 401) // all sessions revoked
	fresh := e.client()
	fresh.mustStatus(fresh.post("/auth/login", map[string]any{"email": "bob@example.com", "password": "another new password"}), 200)

	// expired links
	link2 := admin.mustStatus(admin.post("/admin/users/"+bobID.String()+"/reset-link", nil), 201).m()["url"].(string)
	if _, err := e.pool.Exec(ctx(), `UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	anon.mustStatus(anon.post("/auth/password-reset/confirm", map[string]any{"token": link2[strings.LastIndex(link2, "/")+1:], "newPassword": "another new password"}), 404)
}

func TestProtectedAndPublicRoutes(t *testing.T) {
	e := newEnv(t)
	c, ws := e.setupAdmin()
	anon := e.client()

	// protected routes need a session
	for _, p := range []string{"/auth/me", "/workspaces", "/workspaces/" + ws.String(), "/auth/sessions", "/admin/users"} {
		if r := anon.get(p); r.status != 401 || r.errCode() != "unauthorized" {
			t.Errorf("GET %s without session = %d", p, r.status)
		}
	}
	// public routes do not
	anon.mustStatus(anon.get("/instance/info"), 200)

	// operations wave 2 has not implemented answer 501 with the envelope (after auth)
	pid := c.page(ws, "p", nil)
	r := c.get("/pages/" + pid.String() + "/content")
	c.mustStatus(r, 501)
	if r.errCode() != "internal" {
		t.Fatalf("501 envelope = %s", r.body)
	}
	anon.mustStatus(anon.get("/pages/"+pid.String()+"/content"), 401)

	// unknown API paths and malformed input
	r = c.get("/nope")
	c.mustStatus(r, 404)
	_ = r.errCode()
	c.mustStatus(c.get("/pages/not-a-uuid"), 400)
	c.mustStatus(c.post("/workspaces", "{not json"), 400)
	big := strings.Repeat("a", 2<<20)
	c.mustStatus(c.post("/workspaces", `{"name":"`+big+`"}`), 413)

	if r.header.Get("X-Request-Id") == "" {
		t.Fatal("missing X-Request-Id")
	}
	if r.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", r.header.Get("Cache-Control"))
	}
}

func TestCollabDisconnectRecorderIsWired(t *testing.T) {
	// sanity check of the test double itself, since several tests rely on it
	rec := &collabRecorder{}
	rec.Disconnect(collabclient.DisconnectRequest{UserID: uuid.New()})
	if len(rec.snapshot()) != 1 {
		t.Fatal("recorder broken")
	}
}
