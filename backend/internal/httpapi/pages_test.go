package httpapi_test

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func pp(id uuid.UUID) string { return "/pages/" + id.String() }

// siblings returns the titles of the pages under parent (nil = top level), in tree order.
func (c *client) siblings(ws uuid.UUID, parent *uuid.UUID) []string {
	c.e.t.Helper()
	var out []string
	for _, p := range c.mustStatus(c.get(wsPath(ws, "/pages")), 200).list() {
		pid, _ := p["parentId"].(string)
		switch {
		case parent == nil && pid == "":
			out = append(out, p["title"].(string))
		case parent != nil && pid == parent.String():
			out = append(out, p["title"].(string))
		}
	}
	return out
}

func TestCreatePage(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")
	pages := wsPath(ws, "/pages")

	r := bob.mustStatus(bob.post(pages, map[string]any{"title": "Hello", "icon": "👋"}), 201).m()
	if r["title"] != "Hello" || r["icon"] != "👋" || r["visibility"] != "workspace" || r["parentId"] != nil ||
		r["role"] != "full" || r["workspaceId"] != ws.String() || r["position"] == "" || r["archivedAt"] != nil {
		t.Fatalf("created page = %v", r)
	}
	for _, field := range []string{"createdAt", "updatedAt"} {
		if ts, _ := r[field].(string); !strings.HasSuffix(ts, "Z") {
			t.Fatalf("%s = %q, timestamps must be RFC 3339 UTC", field, ts)
		}
	}
	id, err := uuid.Parse(r["id"].(string))
	if err != nil || id.Version() != 7 {
		t.Fatalf("server-created pages use UUIDv7, got %v (%v)", r["id"], err)
	}

	// idempotent by client id: same creator -> 200 with the same page; another user -> 409
	clientID, _ := uuid.NewV7()
	first := bob.mustStatus(bob.post(pages, map[string]any{"id": clientID.String(), "title": "Offline made"}), 201).m()
	again := bob.mustStatus(bob.post(pages, map[string]any{"id": clientID.String(), "title": "Offline made"}), 200).m()
	if !reflect.DeepEqual(first, again) {
		t.Fatalf("retry returned a different page:\n%v\n%v", first, again)
	}
	admin.mustStatus(admin.post(pages, map[string]any{"id": clientID.String(), "title": "Stolen"}), 409)
	other := admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Other"}), 201).m()
	otherWS := uuid.MustParse(other["workspace"].(map[string]any)["id"].(string))
	bob2, _ := e.newUser(admin, otherWS, "member", "Bob2")
	bob2.mustStatus(bob2.post(wsPath(otherWS, "/pages"), map[string]any{"id": clientID.String()}), 409) // id taken in another workspace

	// nested creation, private roots, validation
	child := bob.mustStatus(bob.post(pages, map[string]any{"title": "Child", "parentId": id.String()}), 201).m()
	if child["parentId"] != id.String() || child["visibility"] != "workspace" {
		t.Fatalf("child = %v", child)
	}
	priv := bob.mustStatus(bob.post(pages, map[string]any{"title": "Secret", "visibility": "private"}), 201).m()
	if priv["visibility"] != "private" || priv["role"] != "full" {
		t.Fatalf("private root = %v", priv)
	}
	bob.mustStatus(bob.post(pages, map[string]any{"title": "x", "parentId": id.String(), "visibility": "private"}), 422)
	bob.mustStatus(bob.post(pages, map[string]any{"title": "x", "visibility": "secret"}), 422)
	bob.mustStatus(bob.post(pages, map[string]any{"title": strings.Repeat("a", 501)}), 422)
	bob.mustStatus(bob.post(pages, map[string]any{"title": "x", "id": "00000000-0000-0000-0000-000000000000"}), 422)
	bob.mustStatus(bob.post(pages, map[string]any{"title": "x", "id": "not-a-uuid"}), 400)

	// the parent must be visible and editable
	privID := uuid.MustParse(priv["id"].(string))
	admin.mustStatus(admin.post(pages, map[string]any{"title": "x", "parentId": uuid.NewString()}), 404)
	e.mustGrant(bob, privID, ginaID, "view")
	gina.mustStatus(gina.post(pages, map[string]any{"title": "x", "parentId": privID.String()}), 403) // can see it, may not edit
	alice, _ := e.newUser(admin, ws, "member", "Alice")
	alice.mustStatus(alice.post(pages, map[string]any{"title": "x", "parentId": privID.String()}), 404) // cannot see it at all
	// guests cannot create top-level pages; with edit on a page they can add children
	gina.mustStatus(gina.post(pages, map[string]any{"title": "x"}), 403)
	e.mustGrant(bob, privID, ginaID, "edit")
	gc := gina.mustStatus(gina.post(pages, map[string]any{"title": "Guest child", "parentId": privID.String()}), 201).m()
	if gc["role"] != "full" { // creator ownership applies to guests too
		t.Fatalf("guest child = %v", gc)
	}
	// ... but only on what she created: the parent she was granted `edit` on is unchanged
	if r := gina.get(pp(privID)).m()["page"].(map[string]any)["role"]; r != "edit" {
		t.Fatalf("guest role on the shared parent = %v", r)
	}
	// parents of another workspace do not exist
	bob2.mustStatus(bob2.post(wsPath(otherWS, "/pages"), map[string]any{"title": "x", "parentId": id.String()}), 404)
	// archived parents are refused
	admin.mustStatus(admin.post(pp(id)+"/archive", nil), 204)
	alice.mustStatus(alice.post(pages, map[string]any{"title": "x", "parentId": id.String()}), 404) // archived pages are invisible to non-full users
	bob.mustStatus(bob.post(pages, map[string]any{"title": "x", "parentId": id.String()}), 409)     // ... but not to their creator
	admin.mustStatus(admin.post(pages, map[string]any{"title": "x", "parentId": id.String()}), 409)
	// non-members
	stranger, _ := e.newUser(admin, otherWS, "member", "Stranger")
	stranger.mustStatus(stranger.post(pages, map[string]any{"title": "x"}), 404)
}

// mustGrant grants role on page to user as c.
func (e *env) mustGrant(c *client, page, user uuid.UUID, role string) {
	e.t.Helper()
	c.mustStatus(c.post(pp(page)+"/permissions", map[string]any{"userId": user.String(), "role": role}), 200)
}

func TestPageOrdering(t *testing.T) {
	e := newEnv(t)
	c, ws := e.setupAdmin()
	id := map[string]uuid.UUID{}
	for _, n := range []string{"A", "B", "C"} {
		id[n] = c.page(ws, n, nil)
	}
	if got := c.siblings(ws, nil); !reflect.DeepEqual(got, []string{"A", "B", "C"}) {
		t.Fatalf("appended pages out of order: %v", got)
	}
	add := func(title string, extra map[string]any) {
		body := map[string]any{"title": title}
		for k, v := range extra {
			body[k] = v
		}
		id[title] = c.createPage(ws, body)
	}
	add("D", map[string]any{"afterId": id["A"].String()})
	add("E", map[string]any{"beforeId": id["A"].String()})
	add("F", map[string]any{"afterId": id["C"].String()})
	add("G", map[string]any{"afterId": id["D"].String(), "beforeId": id["B"].String()})
	if got := c.siblings(ws, nil); !reflect.DeepEqual(got, []string{"E", "A", "D", "G", "B", "C", "F"}) {
		t.Fatalf("order after afterId/beforeId inserts: %v", got)
	}

	// afterId/beforeId must name siblings of the new parent
	parentA := id["A"]
	child := c.page(ws, "child", &parentA)
	c.mustStatus(c.post(wsPath(ws, "/pages"), map[string]any{"title": "x", "afterId": child.String()}), 422)
	c.mustStatus(c.post(wsPath(ws, "/pages"), map[string]any{"title": "x", "afterId": uuid.NewString()}), 422)
	c.mustStatus(c.post(wsPath(ws, "/pages"), map[string]any{"title": "x", "afterId": id["C"].String(), "beforeId": id["A"].String()}), 422)

	// reorder through move: D after C
	moved := c.mustStatus(c.post(pp(id["D"])+"/move", map[string]any{"parentId": nil, "afterId": id["C"].String()}), 200).m()
	if moved["parentId"] != nil {
		t.Fatalf("moved = %v", moved)
	}
	if got := c.siblings(ws, nil); !reflect.DeepEqual(got, []string{"E", "A", "G", "B", "C", "D", "F"}) {
		t.Fatalf("order after move: %v", got)
	}
	// ... and before the first sibling
	c.mustStatus(c.post(pp(id["F"])+"/move", map[string]any{"parentId": nil, "beforeId": id["E"].String()}), 200)
	if got := c.siblings(ws, nil); got[0] != "F" || len(got) != 7 {
		t.Fatalf("order after move to front: %v", got)
	}
	// the page itself is never its own neighbour
	c.mustStatus(c.post(pp(id["F"])+"/move", map[string]any{"parentId": nil, "afterId": id["F"].String()}), 422)

	// many inserts at the same spot keep a strict order (fractional keys do not collide)
	for i := 0; i < 30; i++ {
		c.createPage(ws, map[string]any{"title": "x", "afterId": id["A"].String()})
	}
	positions := map[string]bool{}
	for _, p := range c.get(wsPath(ws, "/pages")).list() {
		if p["parentId"] == nil {
			pos := p["position"].(string)
			if positions[pos] {
				t.Fatalf("duplicate position %q", pos)
			}
			positions[pos] = true
		}
	}
}

func TestMovePage(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")

	a := admin.page(ws, "A", nil)
	a1 := admin.page(ws, "A1", &a)
	a2 := admin.page(ws, "A2", &a1)
	b := admin.page(ws, "B", nil)

	// reparent and back to top level
	m := admin.mustStatus(admin.post(pp(a2)+"/move", map[string]any{"parentId": b.String()}), 200).m()
	if m["parentId"] != b.String() {
		t.Fatalf("move = %v", m)
	}
	if got := admin.siblings(ws, &b); !reflect.DeepEqual(got, []string{"A2"}) {
		t.Fatalf("children of B: %v", got)
	}
	admin.mustStatus(admin.post(pp(a2)+"/move", map[string]any{"parentId": nil}), 200)
	if got := admin.siblings(ws, nil); !reflect.DeepEqual(got, []string{"A", "B", "A2"}) {
		t.Fatalf("top level: %v", got)
	}

	// cycles -> 422: a page cannot move into itself or into its own descendants
	deep := admin.page(ws, "Deep", &a2) // A2 is top-level again; A2 > Deep
	admin.mustStatus(admin.post(pp(a2)+"/move", map[string]any{"parentId": deep.String()}), 422)
	admin.mustStatus(admin.post(pp(a)+"/move", map[string]any{"parentId": a1.String()}), 422)
	admin.mustStatus(admin.post(pp(a)+"/move", map[string]any{"parentId": a.String()}), 422)
	admin.mustStatus(admin.post(pp(a1)+"/move", map[string]any{"parentId": a.String()}), 200) // moving within the same parent is fine
	admin.mustStatus(admin.post(pp(a)+"/move", map[string]any{}), 422)                        // parentId is required
	admin.mustStatus(admin.post(pp(a)+"/move", map[string]any{"parentId": uuid.NewString()}), 404)

	// needs edit on BOTH the page and the destination parent
	lonely := admin.page(ws, "Lonely", nil)
	e.mustGrant(admin, lonely, ginaID, "edit")
	e.mustGrant(admin, b, ginaID, "view")
	gina.mustStatus(gina.post(pp(lonely)+"/move", map[string]any{"parentId": b.String()}), 403) // may edit the page, only view the target
	e.mustGrant(admin, b, ginaID, "edit")
	gina.mustStatus(gina.post(pp(lonely)+"/move", map[string]any{"parentId": b.String()}), 200)
	gina.mustStatus(gina.post(pp(lonely)+"/move", map[string]any{"parentId": nil}), 403) // guests have no top level
	e.mustGrant(admin, b, ginaID, "view")
	gina.mustStatus(gina.post(pp(a1)+"/move", map[string]any{"parentId": b.String()}), 404) // cannot see A1 at all

	// a destination in another workspace does not exist
	other := admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Other"}), 201).m()
	otherWS := uuid.MustParse(other["workspace"].(map[string]any)["id"].(string))
	foreign := admin.page(otherWS, "Foreign", nil)
	admin.mustStatus(admin.post(pp(a)+"/move", map[string]any{"parentId": foreign.String()}), 404)

	// privacy: a page leaving a private tree stays private; moving a private root into a shared
	// tree is a sharing decision that needs full access
	secret := bob.createPage(ws, map[string]any{"title": "Secret", "visibility": "private"})
	inner := bob.page(ws, "Inner", &secret)
	out := bob.mustStatus(bob.post(pp(inner)+"/move", map[string]any{"parentId": nil}), 200).m()
	if out["visibility"] != "private" || out["role"] != "full" {
		t.Fatalf("a page moved out of a private tree must stay private: %v", out)
	}
	alice, _ := e.newUser(admin, ws, "member", "Alice")
	alice.mustStatus(alice.get(pp(inner)), 404)
	bob.mustStatus(bob.post(pp(secret)+"/move", map[string]any{"parentId": b.String()}), 200) // bob has full on his own private root
	alice.mustStatus(alice.get(pp(secret)), 200)                                              // now it lives in a shared tree
	// edit alone is not enough to widen a private page's audience
	secret2 := admin.createPage(ws, map[string]any{"title": "Secret2", "visibility": "private"})
	e.mustGrant(admin, secret2, bobID, "edit")
	bob.mustStatus(bob.post(pp(secret2)+"/move", map[string]any{"parentId": b.String()}), 403)
	e.mustGrant(admin, secret2, bobID, "full")
	bob.mustStatus(bob.post(pp(secret2)+"/move", map[string]any{"parentId": b.String()}), 200)

	// moving does not lock the mover out: Bob (granted edit on a page inside Admin's private tree)
	// pulls it to the top level, where it would become a private root of its creator
	priv := admin.createPage(ws, map[string]any{"title": "AdminPriv", "visibility": "private"})
	pc := admin.page(ws, "Shared child", &priv)
	e.mustGrant(admin, pc, bobID, "edit")
	pulled := bob.mustStatus(bob.post(pp(pc)+"/move", map[string]any{"parentId": nil}), 200).m()
	if pulled["role"] == nil || pulled["role"] == "" {
		t.Fatalf("mover lost access: %v", pulled)
	}
	bob.mustStatus(bob.get(pp(pc)), 200)
}

func TestArchiveRestorePurge(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")

	root := bob.page(ws, "Root", nil)
	kid := bob.page(ws, "Kid", &root)
	grandkid := bob.page(ws, "Grandkid", &kid)
	sibling := bob.page(ws, "Sibling", nil)
	_ = sibling
	// Alice only has `edit` on Bob's workspace page; Bob (creator) and admins have full
	alice, _ := e.newUser(admin, ws, "member", "Alice")
	alice.mustStatus(alice.post(pp(root)+"/archive", nil), 403)
	alice.mustStatus(alice.post(pp(kid)+"/archive", nil), 403)

	// an older, separately archived grandchild must keep its own timestamp
	old := admin.page(ws, "Old", &kid)
	admin.mustStatus(admin.post(pp(old)+"/archive", nil), 204)
	time.Sleep(20 * time.Millisecond)

	admin.mustStatus(admin.post(pp(root)+"/archive", nil), 204)
	admin.mustStatus(admin.post(pp(root)+"/archive", nil), 409) // already in the trash
	if got := admin.siblings(ws, nil); !reflect.DeepEqual(got, []string{"Sibling"}) {
		t.Fatalf("archived pages must leave the tree: %v", got)
	}
	var stamps []time.Time
	rows, err := e.pool.Query(ctx(), `SELECT archived_at FROM pages WHERE id = ANY($1) ORDER BY title`, []uuid.UUID{grandkid, kid, root})
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var ts time.Time
		if err := rows.Scan(&ts); err != nil {
			t.Fatal(err)
		}
		stamps = append(stamps, ts)
	}
	rows.Close()
	if len(stamps) != 3 || !stamps[0].Equal(stamps[1]) || !stamps[1].Equal(stamps[2]) {
		t.Fatalf("the whole subtree must share one archived_at: %v", stamps)
	}

	// trash: only subtree roots, only for users with full access
	trash := admin.mustStatus(admin.get(wsPath(ws, "/trash")), 200).list()
	titles := []string{}
	for _, p := range trash {
		titles = append(titles, p["title"].(string))
		if p["archivedAt"] == nil || p["role"] != "full" {
			t.Fatalf("trash item = %v", p)
		}
	}
	if !reflect.DeepEqual(titles, []string{"Root", "Old"}) { // newest first; Old became its own root
		// "Old" was archived first, so Root (newer) is listed first
		t.Fatalf("trash = %v", titles)
	}
	if got := alice.mustStatus(alice.get(wsPath(ws, "/trash")), 200).list(); len(got) != 0 {
		t.Fatalf("members without full access must not see the trash: %v", got)
	}
	// Bob created Root (and Kid under Old), so he owns both trash entries
	if got := bob.mustStatus(bob.get(wsPath(ws, "/trash")), 200).list(); len(got) != 2 {
		t.Fatalf("a creator sees their trashed pages: %v", got)
	}

	// archived pages: full holders may read them, everybody else gets 404, writes are 409
	d := admin.mustStatus(admin.get(pp(root)), 200).m()["page"].(map[string]any)
	if d["archivedAt"] == nil {
		t.Fatalf("archived page = %v", d)
	}
	alice.mustStatus(alice.get(pp(root)), 404)
	admin.mustStatus(admin.patch(pp(root), map[string]any{"title": "x"}), 409)
	admin.mustStatus(admin.post(pp(root)+"/move", map[string]any{"parentId": nil}), 409)
	admin.mustStatus(admin.post(pp(root)+"/collab-token", nil), 409)
	admin.mustStatus(admin.post(pp(root)+"/duplicate", nil), 409)
	admin.mustStatus(admin.put(pp(root)+"/favorite", nil), 409)
	// only archived pages can be purged
	admin.mustStatus(admin.delete(pp(sibling)), 409)

	// restore brings back exactly the rows with the same timestamp
	r := admin.mustStatus(admin.post(pp(root)+"/restore", nil), 200).m()
	if r["archivedAt"] != nil || r["parentId"] != nil {
		t.Fatalf("restored = %v", r)
	}
	if got := admin.siblings(ws, nil); !reflect.DeepEqual(got, []string{"Sibling", "Root"}) && !reflect.DeepEqual(got, []string{"Root", "Sibling"}) {
		t.Fatalf("top level after restore: %v", got)
	}
	if got := admin.siblings(ws, &kid); !reflect.DeepEqual(got, []string{"Grandkid"}) {
		t.Fatalf("only the rows archived together come back (not the separately archived one): %v", got)
	}
	admin.mustStatus(admin.post(pp(root)+"/restore", nil), 409) // not in the trash any more
	admin.mustStatus(admin.post(pp(old)+"/restore", nil), 200)
	if got := admin.siblings(ws, &kid); !reflect.DeepEqual(got, []string{"Grandkid", "Old"}) && !reflect.DeepEqual(got, []string{"Old", "Grandkid"}) {
		t.Fatalf("kid's children: %v", got)
	}

	// restoring a child of an archived parent surfaces it at the top level
	admin.mustStatus(admin.post(pp(root)+"/archive", nil), 204)
	r = admin.mustStatus(admin.post(pp(kid)+"/restore", nil), 200).m()
	if r["parentId"] != nil {
		t.Fatalf("kid should be top-level now: %v", r)
	}

	// purge: archived pages only; cascades to the subtree and derived data
	if _, err := e.pool.Exec(ctx(), `INSERT INTO page_documents (page_id, ydoc) VALUES ($1, '\x00')`, root); err != nil {
		t.Fatal(err)
	}
	admin.mustStatus(admin.delete(pp(root)), 204)
	admin.mustStatus(admin.get(pp(root)), 404)
	admin.mustStatus(admin.delete(pp(root)), 404)
	var n int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM pages WHERE id = $1`, root).Scan(&n)
	var docs int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM page_documents WHERE page_id = $1`, root).Scan(&docs)
	if n+docs != 0 {
		t.Fatalf("purge left rows: pages=%d documents=%d", n, docs)
	}
	// Kid was restored out of the purged subtree and must survive
	admin.mustStatus(admin.get(pp(kid)), 200)
	// pages the caller cannot see answer 404 for every verb
	admin.mustStatus(admin.delete(pp(uuid.New())), 404)
}

func TestDuplicatePage(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")

	root := admin.page(ws, "Plan", nil)
	k1 := admin.page(ws, "Kid 1", &root)
	k2 := admin.page(ws, "Kid 2", &root)
	g := admin.page(ws, "Grandkid", &k1)
	target := admin.page(ws, "Linked", nil)
	// content that must be copied
	for _, id := range []uuid.UUID{root, g} {
		if _, err := e.pool.Exec(ctx(), `INSERT INTO page_documents (page_id, ydoc) VALUES ($1, $2)`, id, []byte("ydoc-"+id.String())); err != nil {
			t.Fatal(err)
		}
		if _, err := e.pool.Exec(ctx(), `INSERT INTO page_content (page_id, markdown, plaintext, blocks) VALUES ($1, $2, $2, '[{"id":"b1"}]')`, id, "text of "+id.String()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.pool.Exec(ctx(), `INSERT INTO page_links (source_page_id, target_page_id) VALUES ($1, $2)`, root, target); err != nil {
		t.Fatal(err)
	}
	_ = k2

	dup := admin.mustStatus(admin.post(pp(root)+"/duplicate", nil), 201).m()
	newRoot := uuid.MustParse(dup["id"].(string))
	if dup["title"] != "Plan (copy)" || newRoot == root || uuid.MustParse(dup["id"].(string)).Version() != 7 || dup["parentId"] != nil {
		t.Fatalf("copy = %v", dup)
	}
	// placed right after the original
	if got := admin.siblings(ws, nil); !reflect.DeepEqual(got, []string{"Plan", "Plan (copy)", "Linked"}) {
		t.Fatalf("top level: %v", got)
	}
	// subtree copied with new ids but the same shape and titles
	kids := admin.siblings(ws, &newRoot)
	if !reflect.DeepEqual(kids, []string{"Kid 1", "Kid 2"}) {
		t.Fatalf("copied children: %v", kids)
	}
	var copiedKid uuid.UUID
	if err := e.pool.QueryRow(ctx(), `SELECT id FROM pages WHERE parent_id = $1 AND title = 'Kid 1'`, newRoot).Scan(&copiedKid); err != nil || copiedKid == k1 {
		t.Fatalf("copied kid: %v %v", copiedKid, err)
	}
	if got := admin.siblings(ws, &copiedKid); !reflect.DeepEqual(got, []string{"Grandkid"}) {
		t.Fatalf("copied grandchildren: %v", got)
	}
	// documents, content and links are copied too
	var doc []byte
	var md string
	if err := e.pool.QueryRow(ctx(), `SELECT d.ydoc, c.markdown FROM page_documents d JOIN page_content c USING (page_id) WHERE page_id = $1`, newRoot).Scan(&doc, &md); err != nil {
		t.Fatal(err)
	}
	if string(doc) != "ydoc-"+root.String() || md != "text of "+root.String() {
		t.Fatalf("copied content: %q %q", doc, md)
	}
	var linked int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM page_links WHERE source_page_id = $1 AND target_page_id = $2`, newRoot, target).Scan(&linked)
	if linked != 1 {
		t.Fatal("page links of the copy are missing")
	}
	var copiedDocs int
	_ = e.pool.QueryRow(ctx(), `SELECT count(*) FROM page_documents WHERE page_id IN (SELECT id FROM pages WHERE title LIKE 'Grandkid' AND id <> $1)`, g).Scan(&copiedDocs)
	if copiedDocs != 1 {
		t.Fatal("the grandchild's document was not copied")
	}

	// includeSubpages=false copies only the page itself
	single := admin.mustStatus(admin.post(pp(root)+"/duplicate", map[string]any{"includeSubpages": false}), 201).m()
	if got := admin.siblings(ws, ptr(uuid.MustParse(single["id"].(string)))); len(got) != 0 {
		t.Fatalf("includeSubpages=false copied children: %v", got)
	}

	// a guest with view on the source but no edit access where the copy would go cannot duplicate;
	// the copy never includes pages the caller cannot see
	e.mustGrant(admin, k1, ginaID, "view")
	gina.mustStatus(gina.post(pp(k1)+"/duplicate", nil), 403)
	e.mustGrant(admin, root, ginaID, "edit")
	e.mustGrant(admin, k2, ginaID, "view") // explicit grants never lower... keep the invisible one below
	hidden := admin.createPage(ws, map[string]any{"title": "Top secret", "visibility": "private"})
	_ = hidden
	res := gina.mustStatus(gina.post(pp(k1)+"/duplicate", nil), 201).m()
	if res["parentId"] != root.String() {
		t.Fatalf("copy of a child lands next to it: %v", res)
	}
	// private roots stay private when copied (and are owned by the copier)
	priv := admin.createPage(ws, map[string]any{"title": "Mine", "visibility": "private"})
	pcopy := admin.mustStatus(admin.post(pp(priv)+"/duplicate", nil), 201).m()
	if pcopy["visibility"] != "private" {
		t.Fatalf("copy of a private root = %v", pcopy)
	}
	gina.mustStatus(gina.post(pp(priv)+"/duplicate", nil), 404)
}

func ptr[T any](v T) *T { return &v }

func TestFavoritesRecentAndGet(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")

	a := admin.page(ws, "A", nil)
	b := admin.page(ws, "B", &a)
	c := admin.page(ws, "C", &b)
	secret := admin.createPage(ws, map[string]any{"title": "Secret", "visibility": "private"})

	// favorites
	bob.mustStatus(bob.put(pp(a)+"/favorite", nil), 204)
	bob.mustStatus(bob.put(pp(a)+"/favorite", nil), 204) // idempotent
	bob.mustStatus(bob.put(pp(c)+"/favorite", nil), 204)
	bob.mustStatus(bob.put(pp(secret)+"/favorite", nil), 404)
	favs := bob.mustStatus(bob.get(wsPath(ws, "/favorites")), 200).list()
	if len(favs) != 2 || favs[0]["title"] != "C" || favs[1]["title"] != "A" { // most recently favorited first
		t.Fatalf("favorites = %v", favs)
	}
	if got := admin.get(wsPath(ws, "/favorites")).list(); len(got) != 0 {
		t.Fatalf("favorites are per user: %v", got)
	}
	bob.mustStatus(bob.delete(pp(a)+"/favorite"), 204)
	bob.mustStatus(bob.delete(pp(a)+"/favorite"), 204)
	bob.mustStatus(bob.delete(pp(secret)+"/favorite"), 204) // reveals nothing
	if favs = bob.get(wsPath(ws, "/favorites")).list(); len(favs) != 1 {
		t.Fatalf("favorites = %v", favs)
	}

	// page detail: role, breadcrumbs, favorite flag, last editor
	d := bob.mustStatus(bob.get(pp(c)), 200).m()
	if d["isFavorite"] != true || d["page"].(map[string]any)["role"] != "edit" {
		t.Fatalf("detail = %v", d)
	}
	crumbs := d["breadcrumbs"].([]any)
	if len(crumbs) != 2 || crumbs[0].(map[string]any)["title"] != "A" || crumbs[1].(map[string]any)["title"] != "B" {
		t.Fatalf("breadcrumbs = %v", crumbs)
	}
	le := d["lastEditedBy"].(map[string]any)
	if le["name"] != "Admin" || le["email"] != nil {
		t.Fatalf("lastEditedBy = %v", le)
	}
	bob.mustStatus(bob.patch(pp(c), map[string]any{"title": "C2"}), 200)
	if bob.get(pp(c)).m()["lastEditedBy"].(map[string]any)["id"] != bobID.String() {
		t.Fatal("lastEditedBy not updated")
	}

	// breadcrumbs and parentId only expose what the caller can see
	e.mustGrant(admin, c, ginaID, "view")
	gd := gina.mustStatus(gina.get(pp(c)), 200).m()
	if len(gd["breadcrumbs"].([]any)) != 0 || gd["page"].(map[string]any)["parentId"] != nil || gd["page"].(map[string]any)["role"] != "view" {
		t.Fatalf("guest detail leaks ancestors: %v", gd)
	}
	e.mustGrant(admin, b, ginaID, "view")
	gd = gina.get(pp(c)).m()
	if bc := gd["breadcrumbs"].([]any); len(bc) != 1 || bc[0].(map[string]any)["title"] != "B" {
		t.Fatalf("guest breadcrumbs = %v", gd["breadcrumbs"])
	}
	list := gina.mustStatus(gina.get(wsPath(ws, "/pages")), 200).list()
	if len(list) != 2 {
		t.Fatalf("guest page list = %v", list)
	}
	for _, p := range list {
		if p["title"] == "B" && p["parentId"] != nil {
			t.Fatalf("B's parent A is invisible to Gina but its id leaked: %v", p)
		}
	}
	bob.mustStatus(bob.get(pp(secret)), 404)
	bob.mustStatus(bob.get(pp(uuid.New())), 404)

	// updates: title/icon/cover, null clears, comment role cannot edit
	u := bob.mustStatus(bob.patch(pp(a), map[string]any{"title": "Alpha", "icon": "🅰️", "cover": "#112233"}), 200).m()
	if u["title"] != "Alpha" || u["icon"] != "🅰️" || u["cover"] != "#112233" {
		t.Fatalf("update = %v", u)
	}
	u = bob.mustStatus(bob.patch(pp(a), map[string]any{"icon": nil}), 200).m()
	if u["icon"] != nil || u["title"] != "Alpha" || u["cover"] != "#112233" {
		t.Fatalf("clearing the icon changed other fields: %v", u)
	}
	bob.mustStatus(bob.patch(pp(a), map[string]any{"title": strings.Repeat("x", 501)}), 422)
	e.mustGrant(admin, a, ginaID, "comment")
	gina.mustStatus(gina.patch(pp(a), map[string]any{"title": "nope"}), 403)
	admin.mustStatus(admin.patch(pp(secret), map[string]any{}), 200) // empty patch is a no-op

	// recent: most recently updated first, limited
	rec := bob.mustStatus(bob.get(wsPath(ws, "/recent?limit=2")), 200).list()
	if len(rec) != 2 || rec[0]["title"] != "Alpha" {
		t.Fatalf("recent = %v", rec)
	}
	bob.mustStatus(bob.get(wsPath(ws, "/recent?limit=0")), 400)
	for _, p := range bob.get(wsPath(ws, "/recent")).list() {
		if p["title"] == "Secret" {
			t.Fatal("recent leaked a private page")
		}
	}
	// archived pages vanish from favorites and recent
	admin.mustStatus(admin.post(pp(c)+"/archive", nil), 204)
	if favs = bob.get(wsPath(ws, "/favorites")).list(); len(favs) != 0 {
		t.Fatalf("archived favorite still listed: %v", favs)
	}
}
