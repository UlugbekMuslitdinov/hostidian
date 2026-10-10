package httpapi_test

import (
	"strings"
	"testing"
)

func memberRole(c *client, ws, email string) string {
	for _, m := range c.mustStatus(c.get("/workspaces/"+ws+"/members"), 200).list() {
		if m["user"].(map[string]any)["email"] == email {
			return m["role"].(string)
		}
	}
	return ""
}

func TestAdminCreateUserWithPasswordAndMemberships(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()

	r := admin.mustStatus(admin.post("/admin/users", map[string]any{
		"name": "Carol", "email": "Carol@Example.com", "password": testPassword,
		"memberships": []map[string]any{{"workspaceId": ws.String(), "role": "member"}},
	}), 201).m()
	if r["setPasswordUrl"] != nil {
		t.Fatalf("a password was given, so no set-password link is expected: %v", r)
	}
	if got := memberRole(admin, ws.String(), "carol@example.com"); got != "member" {
		t.Fatalf("carol's workspace role = %q, want member", got)
	}

	// The new account can sign in with the password the admin chose.
	carol := e.client()
	carol.mustStatus(carol.post("/auth/login", map[string]any{"email": "carol@example.com", "password": testPassword}), 200)
	if n := len(carol.mustStatus(carol.get("/workspaces"), 200).list()); n != 1 {
		t.Fatalf("carol sees %d workspaces, want 1", n)
	}

	// Same email (any case) → 409; weak password → 422; non-admins → 403; promotion works.
	admin.mustStatus(admin.post("/admin/users", map[string]any{"name": "Dup", "email": "carol@example.com", "password": testPassword}), 409)
	admin.mustStatus(admin.post("/admin/users", map[string]any{"name": "Weak", "email": "weak@example.com", "password": "short"}), 422)
	carol.mustStatus(carol.post("/admin/users", map[string]any{"name": "X", "email": "x@example.com", "password": testPassword}), 403)
	d := admin.mustStatus(admin.post("/admin/users", map[string]any{
		"name": "Dan", "email": "dan@example.com", "password": testPassword, "isInstanceAdmin": true,
	}), 201).m()
	if d["user"].(map[string]any)["isInstanceAdmin"] != true {
		t.Fatalf("dan should be an instance admin: %v", d)
	}
}

func TestAdminCreateUserWithoutPasswordGetsSetPasswordLink(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin()

	r := admin.mustStatus(admin.post("/admin/users", map[string]any{"name": "Erin", "email": "erin@example.com"}), 201).m()
	link, _ := r["setPasswordUrl"].(string)
	if !strings.Contains(link, "/reset-password/") || r["setPasswordExpiresAt"] == nil {
		t.Fatalf("expected a set-password link with an expiry, got %v", r)
	}
	token := link[strings.LastIndex(link, "/")+1:]

	// Until the link is used the account has no password, so nobody can sign in as it.
	erin := e.client()
	erin.mustStatus(erin.post("/auth/login", map[string]any{"email": "erin@example.com", "password": testPassword}), 401)

	erin.mustStatus(erin.post("/auth/password-reset/confirm", map[string]any{"token": token, "newPassword": "erins brand new password"}), 204)
	erin.mustStatus(erin.post("/auth/login", map[string]any{"email": "erin@example.com", "password": "erins brand new password"}), 200)
	// single use
	erin.mustStatus(erin.post("/auth/password-reset/confirm", map[string]any{"token": token, "newPassword": "another new password"}), 404)
}

func TestAdminCreateUserCannotReachWorkspacesTheAdminIsNotIn(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	// A second workspace owned by someone else; the instance admin is not a member of it.
	bob, bobWS := func() (*client, string) {
		b, _ := e.newUser(admin, ws, "member", "Bob")
		b.mustStatus(b.post("/auth/login", map[string]any{"email": "bob@example.com", "password": testPassword}), 200)
		w := b.mustStatus(b.post("/workspaces", map[string]any{"name": "Bobs"}), 201).m()["workspace"].(map[string]any)["id"].(string)
		return b, w
	}()
	_ = bob
	admin.mustStatus(admin.post("/admin/users", map[string]any{
		"name": "Mallory", "email": "mallory@example.com", "password": testPassword,
		"memberships": []map[string]any{{"workspaceId": bobWS, "role": "member"}},
	}), 404) // the admin has no standing in that workspace; it does not even exist for them
	// …and nothing was half-created.
	admin.mustStatus(admin.post("/admin/users", map[string]any{"name": "Mallory", "email": "mallory@example.com", "password": testPassword}), 201)
}

func TestAddMemberByEmail(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	w := ws.String()
	member, _ := e.newUser(admin, ws, "member", "Mia")
	// a second account that is in no workspace yet
	admin.mustStatus(admin.post("/admin/users", map[string]any{"name": "Zed", "email": "zed@example.com", "password": testPassword}), 201)

	r := admin.mustStatus(admin.post("/workspaces/"+w+"/members", map[string]any{"email": "ZED@example.com", "role": "guest"}), 201).m()
	if r["role"] != "guest" || r["user"].(map[string]any)["email"] != "zed@example.com" {
		t.Fatalf("unexpected member %v", r)
	}
	admin.mustStatus(admin.post("/workspaces/"+w+"/members", map[string]any{"email": "zed@example.com", "role": "member"}), 409)
	if got := memberRole(admin, w, "zed@example.com"); got != "guest" {
		t.Fatalf("an existing role must not change on a duplicate add; got %q", got)
	}
	admin.mustStatus(admin.post("/workspaces/"+w+"/members", map[string]any{"email": "nobody@example.com", "role": "member"}), 404)
	admin.mustStatus(admin.post("/workspaces/"+w+"/members", map[string]any{"role": "member"}), 422)
	admin.mustStatus(admin.post("/workspaces/"+w+"/members", map[string]any{"email": "zed@example.com", "role": "owner"}), 422)

	// plain members cannot add anybody
	member.mustStatus(member.post("/workspaces/"+w+"/members", map[string]any{"email": "zed@example.com", "role": "member"}), 403)
}

func TestOnlyOwnersAddAdmins(t *testing.T) {
	e := newEnv(t)
	owner, ws := e.setupAdmin()
	w := ws.String()
	adminUser, adminID := e.newUser(owner, ws, "admin", "Ada")
	_ = adminID
	owner.mustStatus(owner.post("/admin/users", map[string]any{"name": "Neo", "email": "neo@example.com", "password": testPassword}), 201)
	adminUser.mustStatus(adminUser.post("/workspaces/"+w+"/members", map[string]any{"email": "neo@example.com", "role": "admin"}), 403)
	adminUser.mustStatus(adminUser.post("/workspaces/"+w+"/members", map[string]any{"email": "neo@example.com", "role": "member"}), 201)
}
