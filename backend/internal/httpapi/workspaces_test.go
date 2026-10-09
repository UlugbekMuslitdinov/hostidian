package httpapi_test

import (
	"testing"

	"github.com/google/uuid"
)

func wsPath(ws uuid.UUID, rest string) string { return "/workspaces/" + ws.String() + rest }

func TestWorkspaceLifecycle(t *testing.T) {
	e := newEnv(t)
	admin, defaultWS := e.setupAdmin()
	bob, _ := e.newUser(admin, defaultWS, "member", "Bob")

	// members may create workspaces by default and become their owner
	created := bob.mustStatus(bob.post("/workspaces", map[string]any{"name": "Bob's Place!", "icon": "🏠"}), 201).m()
	w := created["workspace"].(map[string]any)
	if created["role"] != "owner" || w["slug"] != "bob-s-place" || w["icon"] != "🏠" {
		t.Fatalf("created = %v", created)
	}
	id := uuid.MustParse(w["id"].(string))

	// slugs are unique: derived slugs get a suffix, explicit ones conflict
	second := bob.mustStatus(bob.post("/workspaces", map[string]any{"name": "Bob's Place"}), 201).m()
	if second["workspace"].(map[string]any)["slug"] != "bob-s-place-2" {
		t.Fatalf("slug = %v", second["workspace"])
	}
	bob.mustStatus(bob.post("/workspaces", map[string]any{"name": "X", "slug": "bob-s-place"}), 409)
	bob.mustStatus(bob.post("/workspaces", map[string]any{"name": "X", "slug": "Not Valid"}), 422)
	bob.mustStatus(bob.post("/workspaces", map[string]any{"name": ""}), 422)

	list := bob.mustStatus(bob.get("/workspaces"), 200).list()
	if len(list) != 3 { // Acme (member) + two of his own
		t.Fatalf("bob's workspaces = %v", list)
	}
	// strangers cannot even tell the workspace exists
	admin.mustStatus(admin.get(wsPath(id, "")), 404)
	bob.mustStatus(bob.get(wsPath(id, "")), 200)

	// owner/admin only updates
	upd := bob.mustStatus(bob.patch(wsPath(id, ""), map[string]any{"name": "Renamed", "slug": "renamed"}), 200).m()
	if upd["workspace"].(map[string]any)["name"] != "Renamed" || upd["workspace"].(map[string]any)["icon"] != "🏠" {
		t.Fatalf("update = %v", upd)
	}
	cleared := bob.mustStatus(bob.patch(wsPath(id, ""), map[string]any{"icon": nil}), 200).m()
	if cleared["workspace"].(map[string]any)["icon"] != nil {
		t.Fatalf("icon should be cleared: %v", cleared)
	}
	bob.mustStatus(bob.patch(wsPath(id, ""), map[string]any{"slug": "acme"}), 409) // taken by the default workspace
	bob.mustStatus(bob.patch(wsPath(id, ""), map[string]any{"slug": "bobs-final"}), 200)
	bob.mustStatus(bob.patch(wsPath(defaultWS, ""), map[string]any{"name": "Hijack"}), 403)
	admin.mustStatus(admin.patch(wsPath(id, ""), map[string]any{"name": "Hijack"}), 404)

	// deleting needs an owner and cascades
	p := bob.page(id, "Doomed", nil)
	other, _ := e.newUser(admin, defaultWS, "member", "Cy")
	token := bob.invite(id, "admin", "")
	other.mustStatus(other.post("/auth/invites/"+token, nil), 200)
	other.mustStatus(other.delete(wsPath(id, "")), 403) // admin, not owner
	bob.mustStatus(bob.delete(wsPath(id, "")), 204)
	bob.mustStatus(bob.get(wsPath(id, "")), 404)
	var n int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM pages WHERE id = $1`, p).Scan(&n)
	if n != 0 {
		t.Fatal("pages must be deleted with their workspace")
	}
}

func TestWorkspaceCreationCanBeDisabled(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")
	admin.mustStatus(admin.patch("/admin/settings", map[string]any{"allowWorkspaceCreation": false}), 200)
	bob.mustStatus(bob.post("/workspaces", map[string]any{"name": "Nope"}), 403)
	admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Admins still can"}), 201)
}

func TestMemberListVisibility(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")
	gina, _ := e.newUser(admin, ws, "guest", "Gina")

	names := func(c *client) map[string]string {
		out := map[string]string{}
		for _, m := range c.mustStatus(c.get(wsPath(ws, "/members")), 200).list() {
			u := m["user"].(map[string]any)
			out[u["name"].(string)] = m["role"].(string)
		}
		return out
	}
	if got := names(admin); len(got) != 3 || got["Gina"] != "guest" || got["Admin"] != "owner" {
		t.Fatalf("admin sees %v", got)
	}
	if got := names(bob); len(got) != 2 || got["Gina"] != "" {
		t.Fatalf("regular members must not see guests: %v", got)
	}
	if got := names(gina); len(got) != 1 || got["Gina"] != "guest" {
		t.Fatalf("a guest only sees themselves: %v", got)
	}
}

func TestMemberRoleRules(t *testing.T) {
	e := newEnv(t)
	owner, ws := e.setupAdmin()
	ownerID := uuid.MustParse(owner.get("/auth/me").m()["user"].(map[string]any)["id"].(string))
	adm, admID := e.newUser(owner, ws, "admin", "Adam")
	mem, memID := e.newUser(owner, ws, "member", "Mia")
	_, guestID := e.newUser(owner, ws, "guest", "Gus")
	members := wsPath(ws, "/members/")

	// only owners/admins manage roles
	mem.mustStatus(mem.patch(members+guestID.String(), map[string]any{"role": "member"}), 403)
	adm.mustStatus(adm.patch(members+guestID.String(), map[string]any{"role": "member"}), 200)
	adm.mustStatus(adm.patch(members+guestID.String(), map[string]any{"role": "bogus"}), 422)
	adm.mustStatus(adm.patch(members+uuid.NewString(), map[string]any{"role": "member"}), 404)

	// admins cannot touch owners/admins nor mint owners; owners can
	adm.mustStatus(adm.patch(members+ownerID.String(), map[string]any{"role": "member"}), 403)
	adm.mustStatus(adm.patch(members+memID.String(), map[string]any{"role": "owner"}), 403)
	owner.mustStatus(owner.patch(members+memID.String(), map[string]any{"role": "owner"}), 200)

	// admins cannot touch other admins, but may step down themselves
	_, adm2ID := e.newUser(owner, ws, "admin", "Ada2")
	adm.mustStatus(adm.patch(members+adm2ID.String(), map[string]any{"role": "member"}), 403)
	adm.mustStatus(adm.patch(members+admID.String(), map[string]any{"role": "member"}), 200)
	adm.mustStatus(adm.patch(members+admID.String(), map[string]any{"role": "admin"}), 403) // and cannot undo it

	// the last owner can never be demoted; with a second owner it is fine
	mem.mustStatus(mem.patch(members+memID.String(), map[string]any{"role": "member"}), 200)
	owner.mustStatus(owner.patch(members+ownerID.String(), map[string]any{"role": "member"}), 409)
	owner.mustStatus(owner.patch(members+memID.String(), map[string]any{"role": "owner"}), 200)
	owner.mustStatus(owner.patch(members+ownerID.String(), map[string]any{"role": "admin"}), 200)
	mem.mustStatus(mem.patch(members+memID.String(), map[string]any{"role": "admin"}), 409) // now the only owner

	// a role change closes the user's collab sockets so the new role applies
	found := false
	for _, c := range e.collab.snapshot() {
		if c.UserID == ownerID {
			found = true
		}
	}
	if !found {
		t.Fatal("role change did not trigger a collab disconnect")
	}
}

func TestRemoveAndLeave(t *testing.T) {
	e := newEnv(t)
	owner, ws := e.setupAdmin()
	ownerID := uuid.MustParse(owner.get("/auth/me").m()["user"].(map[string]any)["id"].(string))
	adm, admID := e.newUser(owner, ws, "admin", "Adam")
	mem, memID := e.newUser(owner, ws, "member", "Mia")
	guest, guestID := e.newUser(owner, ws, "guest", "Gus")
	members := wsPath(ws, "/members/")

	// Mia has a grant and a favorite that must disappear with her membership
	page := owner.page(ws, "Shared", nil)
	owner.mustStatus(owner.post("/pages/"+page.String()+"/permissions", map[string]any{"userId": memID.String(), "role": "full"}), 200)
	mem.mustStatus(mem.put("/pages/"+page.String()+"/favorite", nil), 204)

	mem.mustStatus(mem.delete(members+guestID.String()), 403) // plain members cannot remove others
	adm.mustStatus(adm.delete(members+ownerID.String()), 403) // nor admins remove owners
	owner.mustStatus(owner.delete(members+uuid.NewString()), 404)

	e.collab.reset()
	adm.mustStatus(adm.delete(members+memID.String()), 204)
	mem.mustStatus(mem.get(wsPath(ws, "")), 404)
	mem.mustStatus(mem.get("/pages/"+page.String()), 404)
	for _, q := range []string{
		`SELECT count(*) FROM page_permissions WHERE user_id = $1`,
		`SELECT count(*) FROM favorites WHERE user_id = $1`,
	} {
		var n int
		_ = e.pool.QueryRow(ctx(), q, memID).Scan(&n)
		if n != 0 {
			t.Fatalf("%q left %d rows behind", q, n)
		}
	}
	closed := false
	for _, c := range e.collab.snapshot() {
		closed = closed || c.UserID == memID
	}
	if !closed {
		t.Fatal("removed member's collab sockets were not closed")
	}

	// leaving: anybody can, except the last owner
	guest.mustStatus(guest.delete(members+guestID.String()), 204)
	owner.mustStatus(owner.delete(members+ownerID.String()), 409)
	owner.mustStatus(owner.patch(members+admID.String(), map[string]any{"role": "owner"}), 200)
	owner.mustStatus(owner.delete(members+ownerID.String()), 204)
	owner.mustStatus(owner.get(wsPath(ws, "")), 404)
}

func TestInvites(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")
	inv := wsPath(ws, "/invites")

	bob.mustStatus(bob.post(inv, map[string]any{"role": "member"}), 403)
	bob.mustStatus(bob.get(inv), 403)
	stranger := e.client()
	stranger.mustStatus(stranger.get(inv), 401)

	admin.mustStatus(admin.post(inv, map[string]any{"role": "owner"}), 422)
	admin.mustStatus(admin.post(inv, map[string]any{"role": "member", "email": "nope"}), 422)
	admin.mustStatus(admin.post(inv, map[string]any{"role": "member", "expiresInDays": 0}), 422)
	admin.mustStatus(admin.post(inv, map[string]any{"role": "member", "expiresInDays": 91}), 422)

	created := admin.mustStatus(admin.post(inv, map[string]any{"role": "guest", "email": "Gus@Example.com", "expiresInDays": 3}), 201).m()
	if created["role"] != "guest" || created["email"] != "gus@example.com" {
		t.Fatalf("invite = %v", created)
	}
	if url := created["url"].(string); url != publicURL+"/invite/"+created["token"].(string) {
		t.Fatalf("invite url = %s", url)
	}

	token := admin.invite(ws, "member", "")
	list := admin.mustStatus(admin.get(inv), 200).list()
	if len(list) != 2 {
		t.Fatalf("pending invites = %v", list)
	}
	// a used invite drops off the list
	u := e.client()
	u.mustStatus(u.post("/auth/register", map[string]any{"name": "Used", "email": "used@example.com", "password": testPassword, "inviteToken": token}), 201)
	if l := admin.get(inv).list(); len(l) != 1 {
		t.Fatalf("used invite still pending: %v", l)
	}
	// revoke
	id := created["id"].(string)
	admin.mustStatus(admin.delete(inv+"/"+uuid.NewString()), 404)
	admin.mustStatus(admin.delete(inv+"/"+id), 204)
	admin.mustStatus(admin.delete(inv+"/"+id), 404)
	anon := e.client()
	anon.mustStatus(anon.get("/auth/invites/"+created["token"].(string)), 404)
	// invites of another workspace cannot be revoked through this one
	other := admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Other"}), 201).m()
	otherWS := uuid.MustParse(other["workspace"].(map[string]any)["id"].(string))
	oi := admin.mustStatus(admin.post(wsPath(otherWS, "/invites"), map[string]any{"role": "member"}), 201).m()
	admin.mustStatus(admin.delete(inv+"/"+oi["id"].(string)), 404)
}
