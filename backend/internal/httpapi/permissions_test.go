package httpapi_test

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func TestPagePermissionsGrantAndRevoke(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")
	alice, aliceID := e.newUser(admin, ws, "member", "Alice")

	root := bob.createPage(ws, map[string]any{"title": "Roadmap", "visibility": "private"})
	child := bob.page(ws, "Q4", &root)
	perms := func(c *client, page uuid.UUID) map[string]any {
		return c.mustStatus(c.get(pp(page)+"/permissions"), 200).m()
	}

	// who may look at the permissions: full only; invisible pages answer 404
	p := perms(bob, root)
	if p["visibility"] != "private" || p["canChangeVisibility"] != true || len(p["entries"].([]any)) != 0 {
		t.Fatalf("permissions = %v", p)
	}
	alice.mustStatus(alice.get(pp(root)+"/permissions"), 404)
	if c := perms(bob, child); c["canChangeVisibility"] != false || c["visibility"] != "private" {
		t.Fatalf("a child reports its root's visibility and cannot change it: %v", c)
	}

	// grant by id: gina (guest) gets view on the root and, by inheritance, on the child
	e.collab.reset()
	granted := bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "view"}), 200).m()
	entries := granted["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %v", entries)
	}
	en := entries[0].(map[string]any)
	if en["role"] != "view" || en["user"].(map[string]any)["email"] != "gina@example.com" || en["inheritedFrom"] != nil {
		t.Fatalf("entry = %v", en)
	}
	gina.mustStatus(gina.get(pp(child)), 200)
	if r := gina.get(pp(child)).m()["page"].(map[string]any)["role"]; r != "view" {
		t.Fatalf("role = %v", r)
	}
	// ... and the child's permission list shows it as inherited
	inh := perms(bob, child)["entries"].([]any)[0].(map[string]any)
	if inh["inheritedFrom"] != root.String() {
		t.Fatalf("inherited entry = %v", inh)
	}
	// the grantee's live sockets are cut so the new role applies on reconnect
	if !hasDisconnect(e, ginaID) {
		t.Fatalf("no collab disconnect for the grantee: %+v", e.collab.snapshot())
	}

	// changing a role, nearest grant wins
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "edit"}), 200)
	bob.mustStatus(bob.post(pp(child)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "comment"}), 200)
	if r := gina.get(pp(child)).m()["page"].(map[string]any)["role"]; r != "comment" {
		t.Fatalf("nearest grant should win, got %v", r)
	}
	if r := gina.get(pp(root)).m()["page"].(map[string]any)["role"]; r != "edit" {
		t.Fatalf("root role = %v", r)
	}

	// grant by email; unknown email -> 404; unknown id -> 404; neither -> 422; bad role -> 422
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"email": "Alice@Example.com", "role": "comment"}), 200)
	alice.mustStatus(alice.get(pp(root)), 200)
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"email": "nobody@example.com", "role": "view"}), 404)
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"userId": uuid.NewString(), "role": "view"}), 404)
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"role": "view"}), 422)
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"userId": bobID.String(), "role": "owner"}), 422)
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"email": "not-an-email", "role": "view"}), 422)

	// only `full` may share: comment/edit holders get 403, strangers 404
	alice.mustStatus(alice.post(pp(root)+"/permissions", map[string]any{"userId": aliceID.String(), "role": "full"}), 403)
	gina.mustStatus(gina.get(pp(root)+"/permissions"), 403)
	gina.mustStatus(gina.put(pp(root)+"/visibility", map[string]any{"visibility": "workspace"}), 403)
	admin.mustStatus(admin.post(pp(root)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "full"}), 200) // admins always have full

	// revoke removes the grant on exactly this page
	bob.mustStatus(bob.delete(pp(root)+"/permissions/"+uuid.NewString()), 404)
	e.collab.reset()
	bob.mustStatus(bob.delete(pp(child)+"/permissions/"+ginaID.String()), 200)
	if r := gina.get(pp(child)).m()["page"].(map[string]any)["role"]; r != "full" {
		t.Fatalf("after dropping the child grant gina falls back to the root grant, got %v", r)
	}
	r := bob.mustStatus(bob.delete(pp(root)+"/permissions/"+ginaID.String()), 200).m()
	for _, en := range r["entries"].([]any) {
		if en.(map[string]any)["user"].(map[string]any)["id"] == ginaID.String() {
			t.Fatalf("revoked grant still listed: %v", r)
		}
	}
	gina.mustStatus(gina.get(pp(root)), 404)
	gina.mustStatus(gina.get(pp(child)), 404)
	gina.mustStatus(gina.post(pp(root)+"/collab-token", nil), 404)
	bob.mustStatus(bob.delete(pp(root)+"/permissions/"+ginaID.String()), 404) // already gone
	if !hasDisconnect(e, ginaID) {
		t.Fatal("revoking must close the user's sockets")
	}
}

func hasDisconnect(e *env, user uuid.UUID) bool {
	for _, c := range e.collab.snapshot() {
		if c.UserID == user {
			return true
		}
	}
	return false
}

func TestGrantAddsOutsiderAsGuest(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	other := admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Other"}), 201).m()
	otherWS := uuid.MustParse(other["workspace"].(map[string]any)["id"].(string))
	zed, zedID := e.newUser(admin, otherWS, "member", "Zed") // exists on the instance, not in the first workspace

	page := admin.page(ws, "Shared with Zed", nil)
	zed.mustStatus(zed.get(pp(page)), 404)
	admin.mustStatus(admin.post(pp(page)+"/permissions", map[string]any{"email": "zed@example.com", "role": "edit"}), 200)

	var role string
	if err := e.pool.QueryRow(ctx(), `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, ws, zedID).Scan(&role); err != nil || role != "guest" {
		t.Fatalf("zed should be a guest of the workspace now: %q %v", role, err)
	}
	if r := zed.get(pp(page)).m()["page"].(map[string]any)["role"]; r != "edit" {
		t.Fatalf("zed role = %v", r)
	}
	// guests see exactly what was shared, nothing else
	admin.page(ws, "Unshared", nil)
	list := zed.mustStatus(zed.get(wsPath(ws, "/pages")), 200).list()
	if len(list) != 1 || list[0]["title"] != "Shared with Zed" {
		t.Fatalf("guest page list = %v", list)
	}
	zed.mustStatus(zed.get(wsPath(ws, "")), 200)
}

func TestPageVisibility(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")
	alice, aliceID := e.newUser(admin, ws, "member", "Alice")

	root := bob.page(ws, "Draft", nil)
	child := bob.page(ws, "Child", &root)
	alice.mustStatus(alice.get(pp(root)), 200)
	alice.mustStatus(alice.put(pp(root)+"/visibility", map[string]any{"visibility": "private"}), 403) // edit is not enough
	// the creator owns the page and may flip it back and forth
	bob.mustStatus(bob.put(pp(root)+"/visibility", map[string]any{"visibility": "private"}), 200)
	bob.mustStatus(bob.put(pp(root)+"/visibility", map[string]any{"visibility": "workspace"}), 200)
	admin.mustStatus(admin.put(pp(root)+"/visibility", map[string]any{"visibility": "private"}), 200)
	e.mustGrant(admin, root, aliceID, "view")
	admin.mustStatus(admin.delete(pp(root)+"/permissions/"+aliceID.String()), 200)

	// private: only the creator, admins and grantees
	alice.mustStatus(alice.get(pp(root)), 404)
	alice.mustStatus(alice.get(pp(child)), 404)
	if l := alice.get(wsPath(ws, "/pages")).list(); len(l) != 0 {
		t.Fatalf("alice still sees pages: %v", l)
	}
	bob.mustStatus(bob.get(pp(child)), 200)

	// children cannot change visibility; invalid values are rejected
	admin.mustStatus(admin.put(pp(child)+"/visibility", map[string]any{"visibility": "private"}), 422)
	admin.mustStatus(admin.put(pp(root)+"/visibility", map[string]any{"visibility": "secret"}), 422)
	alice.mustStatus(alice.put(pp(root)+"/visibility", map[string]any{"visibility": "workspace"}), 404)

	// back to workspace
	e.collab.reset()
	p := admin.mustStatus(admin.put(pp(root)+"/visibility", map[string]any{"visibility": "workspace"}), 200).m()
	if p["visibility"] != "workspace" {
		t.Fatalf("visibility = %v", p)
	}
	alice.mustStatus(alice.get(pp(child)), 200)
	// both directions close live sockets of the whole subtree
	pages := map[uuid.UUID]bool{}
	for _, c := range e.collab.snapshot() {
		pages[c.PageID] = true
	}
	if !pages[root] || !pages[child] {
		t.Fatalf("collab disconnects = %+v", e.collab.snapshot())
	}
}

func TestCollabToken(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")
	page := bob.page(ws, "Doc", nil)
	e.mustGrant(admin, page, ginaID, "comment")

	r := bob.mustStatus(bob.post(pp(page)+"/collab-token", nil), 200).m()
	if r["role"] != "full" || r["documentName"] != "page:"+page.String() || r["wsUrl"] != "ws://localhost:3000/collab" {
		t.Fatalf("token response = %v", r)
	}
	exp, err := time.Parse(time.RFC3339, r["expiresAt"].(string))
	if err != nil || time.Until(exp) > 121*time.Second || time.Until(exp) < 100*time.Second {
		t.Fatalf("expiresAt = %v (%v)", r["expiresAt"], err)
	}

	claims := jwt.MapClaims{}
	tok, err := jwt.ParseWithClaims(r["token"].(string), claims, func(*jwt.Token) (any, error) { return []byte(e.cfg.CollabJWTSecret), nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithAudience("hostidian-collab"), jwt.WithIssuer("hostidian-api"), jwt.WithExpirationRequired())
	if err != nil || !tok.Valid {
		t.Fatalf("token does not verify: %v", err)
	}
	want := map[string]any{"iss": "hostidian-api", "aud": "hostidian-collab", "sub": bobID.String(), "pageId": page.String(), "role": "full", "name": "Bob"}
	for k, v := range want {
		if claims[k] != v {
			t.Errorf("claim %s = %v, want %v", k, claims[k], v)
		}
	}
	if c, _ := claims["color"].(string); !strings.HasPrefix(c, "#") || len(c) != 7 {
		t.Errorf("color claim = %v", claims["color"])
	}
	iat, _ := claims["iat"].(float64)
	exp2, _ := claims["exp"].(float64)
	if exp2-iat != 120 {
		t.Errorf("exp-iat = %v, want 120", exp2-iat)
	}
	if len(claims) != 9 {
		t.Errorf("unexpected claims: %v", claims)
	}
	// signed with the collab secret only
	if _, err := jwt.Parse(r["token"].(string), func(*jwt.Token) (any, error) { return []byte("wrong"), nil }); err == nil {
		t.Fatal("token verified with the wrong secret")
	}

	// role follows the resolver: the creator is full, other members edit
	alice, _ := e.newUser(admin, ws, "member", "Alice")
	if ar := alice.mustStatus(alice.post(pp(page)+"/collab-token", nil), 200).m(); ar["role"] != "edit" {
		t.Fatalf("a non-creator member should get edit, got %v", ar["role"])
	}
	// invisible pages are 404
	gr := gina.mustStatus(gina.post(pp(page)+"/collab-token", nil), 200).m()
	if gr["role"] != "comment" {
		t.Fatalf("guest role = %v", gr["role"])
	}
	other, _ := e.newUser(admin, ws, "guest", "Other")
	other.mustStatus(other.post(pp(page)+"/collab-token", nil), 404)
	bob.mustStatus(bob.post(pp(uuid.New())+"/collab-token", nil), 404)
	e.client().mustStatus(e.client().post(pp(page)+"/collab-token", nil), 401)
}

// Creator ownership (conventions §3): the creator holds an implicit full grant on a page, inherited by
// its descendants, so members can share, archive and delete what they made - and only that.
func TestCreatorOwnership(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	alice, aliceID := e.newUser(admin, ws, "member", "Alice")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")
	role := func(c *client, page uuid.UUID) string {
		return c.mustStatus(c.get(pp(page)), 200).m()["page"].(map[string]any)["role"].(string)
	}

	root := bob.page(ws, "Bob's root", nil)
	child := alice.page(ws, "Alice's child", &root) // created by Alice under Bob's page
	other := alice.page(ws, "Alice's root", nil)

	// creators are full on their pages and, by inheritance, below them
	if role(bob, root) != "full" || role(bob, child) != "full" || role(alice, child) != "full" {
		t.Fatal("creators must be full on their pages and everything below")
	}
	// ... but only edit on other people's pages
	if role(alice, root) != "edit" || role(bob, other) != "edit" {
		t.Fatalf("others stay edit: alice on bob's root = %s, bob on alice's root = %s", role(alice, root), role(bob, other))
	}

	// non-creators cannot archive, share or flip visibility of someone else's page
	alice.mustStatus(alice.post(pp(root)+"/archive", nil), 403)
	alice.mustStatus(alice.post(pp(root)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "view"}), 403)
	alice.mustStatus(alice.put(pp(root)+"/visibility", map[string]any{"visibility": "private"}), 403)
	bob.mustStatus(bob.post(pp(other)+"/archive", nil), 403)

	// creators can
	bob.mustStatus(bob.post(pp(root)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "view"}), 200)
	gina.mustStatus(gina.get(pp(child)), 200)
	bob.mustStatus(bob.post(pp(child)+"/permissions", map[string]any{"userId": ginaID.String(), "role": "comment"}), 200) // full inherited by the child

	// an explicit grant on a page the creator did not create overrides the inherited implicit full
	// (floored at the member base)
	e.mustGrant(admin, child, bobID, "view")
	if r := role(bob, child); r != "edit" {
		t.Fatalf("explicit view must override inherited ownership down to the base (edit), got %s", r)
	}
	bob.mustStatus(bob.post(pp(child)+"/archive", nil), 403)
	// ... on the page the user created themselves the explicit grant only combines by max
	e.mustGrant(admin, root, bobID, "view")
	if r := role(bob, root); r != "full" {
		t.Fatalf("creator with an explicit view on their own page stays full, got %s", r)
	}
	// Alice, the child's creator, keeps full on it whatever is granted on the parent
	e.mustGrant(admin, root, aliceID, "view")
	if r := role(alice, child); r != "full" {
		t.Fatalf("alice on her own child = %s", r)
	}

	// archive -> trash -> restore -> archive -> purge, all as the creator
	bob.mustStatus(bob.post(pp(root)+"/archive", nil), 204)
	trash := bob.mustStatus(bob.get(wsPath(ws, "/trash")), 200).list()
	if len(trash) != 1 || trash[0]["title"] != "Bob's root" {
		t.Fatalf("trash = %v", trash)
	}
	bob.mustStatus(bob.post(pp(root)+"/restore", nil), 200)
	bob.mustStatus(bob.post(pp(root)+"/archive", nil), 204)
	bob.mustStatus(bob.delete(pp(root)), 204)
	var n int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM pages WHERE id IN ($1, $2)`, root, child).Scan(&n)
	if n != 0 {
		t.Fatalf("%d pages survived the purge", n)
	}
	alice.mustStatus(alice.get(pp(other)), 200) // untouched
}

// A removed member's creator ownership ends with their membership; guests keep it only for what they created.
func TestCreatorOwnershipNeedsMembership(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	page := bob.page(ws, "Mine", nil)
	bob.mustStatus(bob.get(pp(page)), 200)
	admin.mustStatus(admin.delete(wsPath(ws, "/members/"+bobID.String())), 204)
	bob.mustStatus(bob.get(pp(page)), 404)

	// re-joining as a guest: he sees nothing else, but the page he created is his again
	token := admin.invite(ws, "guest", "")
	bob.mustStatus(bob.post("/auth/invites/"+token, nil), 200)
	if r := bob.mustStatus(bob.get(pp(page)), 200).m()["page"].(map[string]any)["role"]; r != "full" {
		t.Fatalf("a guest keeps ownership of the page they created, got %v", r)
	}
	if l := bob.get(wsPath(ws, "/pages")).list(); len(l) != 1 {
		t.Fatalf("guest sees only what they own: %v", l)
	}
}
