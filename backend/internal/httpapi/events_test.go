package httpapi_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type sseEvent struct {
	Type            string
	Data            map[string]any
	PageID, ActorID string
}

// stream is a live GET /workspaces/{id}/events connection.
type stream struct {
	t      *testing.T
	events chan sseEvent
	pings  chan string
	cancel context.CancelFunc
	header http.Header
	done   chan struct{}
}

// subscribe opens the SSE stream and waits for the initial flush.
func (c *client) subscribe(ws uuid.UUID) *stream {
	c.e.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", c.e.ts.URL+"/api"+wsPath(ws, "/events"), nil)
	req.Header.Set("Cookie", c.cookie)
	req.Header.Set("Origin", publicURL)
	res, err := http.DefaultTransport.RoundTrip(req) // returns as soon as headers arrive
	if err != nil {
		cancel()
		c.e.t.Fatal(err)
	}
	s := &stream{t: c.e.t, events: make(chan sseEvent, 64), pings: make(chan string, 16), cancel: cancel, header: res.Header, done: make(chan struct{})}
	if res.StatusCode != 200 {
		cancel()
		c.e.t.Fatalf("SSE status = %d", res.StatusCode)
	}
	go func() {
		defer close(s.done)
		defer close(s.events)
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		var typ string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, ":"):
				s.pings <- line
			case strings.HasPrefix(line, "event: "):
				typ = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var m struct {
					Type    string         `json:"type"`
					PageID  string         `json:"pageId"`
					ActorID string         `json:"actorId"`
					Data    map[string]any `json:"data"`
				}
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m); err == nil {
					if m.Type != typ {
						s.t.Errorf("event line %q != payload type %q", typ, m.Type)
					}
					s.events <- sseEvent{Type: m.Type, Data: m.Data, PageID: m.PageID, ActorID: m.ActorID}
				}
			}
		}
	}()
	c.e.t.Cleanup(cancel)
	select {
	case line := <-s.pings:
		if line != ": connected" {
			c.e.t.Fatalf("first SSE line = %q", line)
		}
	case <-time.After(3 * time.Second):
		c.e.t.Fatal("no data flushed on connect")
	}
	// the handler registers the subscription right after the first flush
	deadline := time.Now().Add(3 * time.Second)
	for !c.e.broker.HasSubscriber(ws, c.userID()) {
		if time.Now().After(deadline) {
			c.e.t.Fatal("subscription never registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return s
}

// userID returns the id of the logged-in user.
func (c *client) userID() uuid.UUID {
	c.e.t.Helper()
	return uuid.MustParse(c.get("/auth/me").m()["user"].(map[string]any)["id"].(string))
}

func (s *stream) expect(typ string) sseEvent {
	s.t.Helper()
	select {
	case ev, ok := <-s.events:
		if !ok {
			s.t.Fatalf("stream closed while waiting for %s", typ)
		}
		if ev.Type != typ {
			s.t.Fatalf("got event %s %v, want %s", ev.Type, ev.Data, typ)
		}
		return ev
	case <-time.After(3 * time.Second):
		s.t.Fatalf("timed out waiting for %s", typ)
	}
	panic("unreachable")
}

func (s *stream) expectNothing() {
	s.t.Helper()
	select {
	case ev, ok := <-s.events:
		if ok {
			s.t.Fatalf("unexpected event %s %v", ev.Type, ev.Data)
		}
	case <-time.After(250 * time.Millisecond):
	}
}

func (s *stream) expectClosed() {
	s.t.Helper()
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
		s.t.Fatal("stream was not closed by the server")
	}
}

func TestSSEStreamAndFiltering(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")
	gina, ginaID := e.newUser(admin, ws, "guest", "Gina")

	adminS, bobS, ginaS := admin.subscribe(ws), bob.subscribe(ws), gina.subscribe(ws)
	if ct := adminS.header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type = %q", ct)
	}
	if cc := adminS.header.Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Fatalf("cache control = %q", cc)
	}

	// page.created: everybody who can view it, with their own role
	p := bob.page(ws, "Notes", nil)
	if ev := adminS.expect("page.created"); ev.PageID != p.String() || ev.Data["role"] != "full" || ev.Data["title"] != "Notes" {
		t.Fatalf("admin event = %+v", ev)
	}
	if ev := bobS.expect("page.created"); ev.Data["role"] != "full" { // creator ownership
		t.Fatalf("bob event = %+v", ev)
	}
	ginaS.expectNothing() // a guest has no access to it

	// share it with Gina: everyone is told to refetch; Gina can see the id now
	e.mustGrant(admin, p, ginaID, "view")
	for name, s := range map[string]*stream{"admin": adminS, "bob": bobS, "gina": ginaS} {
		if ev := s.expect("permissions.changed"); ev.PageID != p.String() {
			t.Fatalf("%s: permissions.changed = %+v", name, ev)
		}
	}
	// updates now reach Gina too, with her role
	bob.mustStatus(bob.patch(pp(p), map[string]any{"title": "Notes v2"}), 200)
	if ev := ginaS.expect("page.updated"); ev.Data["role"] != "view" || ev.Data["title"] != "Notes v2" || ev.ActorID == "" {
		t.Fatalf("gina update = %+v", ev)
	}
	adminS.expect("page.updated")
	bobS.expect("page.updated")

	// private pages stay invisible to other members, and their ids are not leaked by permissions.changed
	secret := admin.createPage(ws, map[string]any{"title": "Secret", "visibility": "private"})
	adminS.expect("page.created")
	bobS.expectNothing()
	e.mustGrant(admin, secret, bobID(t, e, "bob@example.com"), "view")
	adminS.expect("permissions.changed")
	if ev := ginaS.expect("permissions.changed"); ev.PageID != "" {
		t.Fatalf("gina learned the id of a page she cannot see: %+v", ev)
	}
	bobS.expect("permissions.changed")
	bobS.expectNothing()

	// move / archive / restore / delete
	child := bob.page(ws, "Child", &p)
	adminS.expect("page.created")
	bobS.expect("page.created")
	ginaS.expect("page.created") // inherits Gina's view grant; her parent is visible too
	bob.mustStatus(bob.post(pp(child)+"/move", map[string]any{"parentId": nil}), 200)
	if ev := adminS.expect("page.moved"); ev.Data["parentId"] != nil {
		t.Fatalf("moved = %+v", ev)
	}
	adminS.expect("permissions.changed") // the parent changed: grants/visibility inherited differently
	admin.mustStatus(admin.post(pp(p)+"/archive", nil), 204)
	adminS.expect("page.archived")
	bobS.expect("page.moved")
	bobS.expect("permissions.changed")
	bobS.expect("page.archived")
	// the moved page left Gina's shared subtree, so she only hears "refetch", not about the page
	if ev := ginaS.expect("permissions.changed"); ev.PageID != "" {
		t.Fatalf("gina learned the id of the page that left her subtree: %+v", ev)
	}
	ginaS.expect("page.archived")
	admin.mustStatus(admin.post(pp(p)+"/restore", nil), 200)
	adminS.expect("page.restored")
	bobS.expect("page.restored")
	ginaS.expect("page.restored")
	admin.mustStatus(admin.post(pp(p)+"/archive", nil), 204)
	adminS.expect("page.archived")
	bobS.expect("page.archived")
	ginaS.expect("page.archived")
	admin.mustStatus(admin.delete(pp(p)), 204)
	if ev := adminS.expect("page.deleted"); ev.PageID != p.String() {
		t.Fatalf("deleted = %+v", ev)
	}
	bobS.expect("page.deleted")
	ginaS.expect("page.deleted")

	// purging a page nobody else could see only notifies those who could
	admin.mustStatus(admin.post(pp(secret)+"/archive", nil), 204)
	admin.mustStatus(admin.delete(pp(secret)), 204)
	adminS.expect("page.archived")
	adminS.expect("page.deleted")
	bobS.expect("page.archived") // bob has a view grant on it
	bobS.expect("page.deleted")
	ginaS.expectNothing()
}

func bobID(t *testing.T, e *env, email string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := e.pool.QueryRow(ctx(), `SELECT id FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestSSEClosesWhenAccessEnds(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobUID := e.newUser(admin, ws, "member", "Bob")
	cy, _ := e.newUser(admin, ws, "member", "Cy")
	dee, _ := e.newUser(admin, ws, "member", "Dee")

	// non-members cannot subscribe
	stranger := e.client()
	stranger.mustStatus(stranger.get(wsPath(ws, "/events")), 401)
	other := admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Other"}), 201).m()
	otherWS := uuid.MustParse(other["workspace"].(map[string]any)["id"].(string))
	bob.mustStatus(bob.get(wsPath(otherWS, "/events")), 404)

	bobS, cyS, deeS := bob.subscribe(ws), cy.subscribe(ws), dee.subscribe(ws)

	// logging out ends the stream of that session
	cy.mustStatus(cy.post("/auth/logout", nil), 204)
	cyS.expectClosed()

	// removing a member ends theirs
	admin.mustStatus(admin.delete(wsPath(ws, "/members/"+bobUID.String())), 204)
	bobS.expectClosed()

	// disabling an account ends theirs
	deeID := bobID(t, e, "dee@example.com")
	admin.mustStatus(admin.patch("/admin/users/"+deeID.String(), map[string]any{"disabled": true}), 200)
	deeS.expectClosed()

	// deleting the workspace ends everything
	adminS := admin.subscribe(ws)
	admin.mustStatus(admin.delete(wsPath(ws, "")), 204)
	adminS.expectClosed()
}

func TestSSEWrongOrigin(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	admin.mustStatus(admin.request("GET", wsPath(ws, "/events"), nil, func(r *http.Request) { r.Header.Set("Origin", "http://evil.test") }), 403)
}

func TestSSEMemberChanges(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, bobUID := e.newUser(admin, ws, "member", "Bob")
	gina, _ := e.newUser(admin, ws, "guest", "Gina")
	adminS, bobS, ginaS := admin.subscribe(ws), bob.subscribe(ws), gina.subscribe(ws)

	// somebody joins through an invite
	token := admin.invite(ws, "member", "")
	joiner := e.client()
	r := joiner.mustStatus(joiner.post("/auth/register", map[string]any{"name": "New", "email": "new@example.com", "password": testPassword, "inviteToken": token}), 201).m()
	joinerID := r["user"].(map[string]any)["id"].(string)
	for _, s := range []*stream{adminS, bobS} {
		ev := s.expect("member.changed")
		if ev.Data["userId"] != joinerID || ev.Data["role"] != "member" || ev.Data["removed"] != false {
			t.Fatalf("member.changed = %+v", ev)
		}
	}
	ginaS.expectNothing() // guests are not told who joins

	// role changes and removals
	admin.mustStatus(admin.patch(wsPath(ws, "/members/"+bobUID.String()), map[string]any{"role": "admin"}), 200)
	if ev := adminS.expect("member.changed"); ev.Data["role"] != "admin" {
		t.Fatalf("role change event = %+v", ev)
	}
	adminS.expect("permissions.changed")
	admin.mustStatus(admin.delete(wsPath(ws, "/members/"+joinerID)), 204)
	if ev := adminS.expect("member.changed"); ev.Data["removed"] != true {
		t.Fatalf("removal event = %+v", ev)
	}
}
