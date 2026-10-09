package events_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/testutil"
)

func TestMain(m *testing.M) { os.Exit(testutil.Run(m)) }

// feed runs Subscription.Serve into a buffer and exposes the parsed frames.
type feed struct {
	t      *testing.T
	sub    *events.Subscription
	mu     sync.Mutex
	buf    bytes.Buffer
	done   chan error
	cancel context.CancelFunc
}

func (f *feed) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buf.Write(p)
}

func (f *feed) text() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.buf.String()
}

type frame struct {
	Type        string
	WorkspaceID string         `json:"workspaceId"`
	PageID      string         `json:"pageId"`
	ActorID     string         `json:"actorId"`
	Data        map[string]any `json:"data"`
}

// frames returns the events received so far.
func (f *feed) frames() []frame {
	var out []frame
	for _, block := range strings.Split(f.text(), "\n\n") {
		var typ, data string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				typ = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			}
		}
		if typ == "" {
			continue
		}
		var fr frame
		if err := json.Unmarshal([]byte(data), &fr); err != nil {
			f.t.Fatalf("bad frame %q: %v", data, err)
		}
		fr.Type = typ
		out = append(out, fr)
	}
	return out
}

func (f *feed) types() []string {
	var out []string
	for _, fr := range f.frames() {
		out = append(out, fr.Type)
	}
	return out
}

func newFeed(t *testing.T, b *events.Broker, ws, user uuid.UUID, heartbeat time.Duration) *feed {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	f := &feed{t: t, sub: b.Subscribe(ws, user, uuid.New()), done: make(chan error, 1), cancel: cancel}
	go func() { f.done <- f.sub.Serve(ctx, f, func() error { return nil }, heartbeat) }()
	t.Cleanup(func() { cancel(); f.sub.Close() })
	return f
}

// settle gives the subscriber goroutines time to drain; used for "nothing arrived" assertions.
func settle() { time.Sleep(150 * time.Millisecond) }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func page(id uuid.UUID, ws uuid.UUID, parent *uuid.UUID) *gen.PageSummary {
	return &gen.PageSummary{Id: id, WorkspaceId: ws, ParentId: parent, Title: "T", Position: "a0", Visibility: "workspace", CreatedAt: time.Now(), UpdatedAt: time.Now()}
}

func TestVisibilityFiltering(t *testing.T) {
	f := testutil.NewFixture(t)
	owner, alice, bob, gina, olga := f.Member("owen", "owner"), f.Member("alice", "member"), f.Member("bob", "member"), f.Member("gina", "guest"), f.User("olga")
	shared := f.Page("shared", "", "workspace", "alice")
	child := f.Page("child", "shared", "workspace", "alice")
	secret := f.Page("secret", "", "private", "alice")
	_ = olga

	b := events.NewBroker(f.Q, slog.New(slog.NewTextHandler(io.Discard, nil)))
	feeds := map[string]*feed{}
	for name, id := range map[string]uuid.UUID{"owen": owner, "alice": alice, "bob": bob, "gina": gina} {
		feeds[name] = newFeed(t, b, f.WS, id, time.Hour)
	}
	// an outsider subscribed to the workspace (e.g. just removed) gets nothing and is dropped
	outsider := newFeed(t, b, f.WS, olga, time.Hour)

	pub := func(typ string, page uuid.UUID, mod ...func(*events.Event)) {
		ev := events.Event{Type: typ, WorkspaceID: f.WS, PageID: page, ActorID: alice}
		for _, m := range mod {
			m(&ev)
		}
		b.Publish(ev)
	}

	pub(events.PageUpdated, shared)
	pub(events.PageUpdated, secret)
	waitFor(t, "owner+alice to receive both", func() bool { return len(feeds["owen"].frames()) == 2 && len(feeds["alice"].frames()) == 2 })
	settle()
	if got := len(feeds["bob"].frames()); got != 1 {
		t.Fatalf("bob (member) must only see the shared page's event, got %v", feeds["bob"].types())
	}
	if got := len(feeds["gina"].frames()); got != 0 {
		t.Fatalf("a guest without grants must see nothing, got %v", feeds["gina"].types())
	}
	if got := outsider.frames(); len(got) != 0 {
		t.Fatalf("a non-member must see nothing: %v", got)
	}
	waitFor(t, "outsider subscription to be dropped", func() bool {
		select {
		case err := <-outsider.done:
			return err == events.ErrClosed
		default:
			return false
		}
	})

	// per-subscriber rewriting of the summary: role and (masked) parent id
	feeds["gina"].sub.Close()
	f.Grant("child", "gina", "view")
	gina2 := newFeed(t, b, f.WS, gina, time.Hour)
	b.Publish(events.Event{Type: events.PageUpdated, WorkspaceID: f.WS, PageID: child, ActorID: alice, Page: page(child, f.WS, &shared)})
	waitFor(t, "role-rewritten events", func() bool { return len(gina2.frames()) == 1 && len(feeds["alice"].frames()) == 3 })
	gd := gina2.frames()[0].Data
	if gd["role"] != "view" || gd["parentId"] != nil {
		t.Fatalf("gina sees child as view with an invisible parent: %v", gd)
	}
	ad := feeds["alice"].frames()[2].Data
	if ad["role"] != "full" || ad["parentId"] != shared.String() { // alice created the page: creator ownership
		t.Fatalf("alice sees the real role and parent: %v", ad)
	}
	if feeds["owen"].frames()[2].Data["role"] != "full" {
		t.Fatal("owner role should be full")
	}

	// permissions.changed reaches everybody, but only reveals the page id to those who may view it
	b.Publish(events.Event{Type: events.PermissionsChanged, WorkspaceID: f.WS, PageID: secret, ActorID: alice, Audience: events.AudienceAll})
	waitFor(t, "permissions.changed everywhere", func() bool {
		return len(gina2.frames()) == 2 && len(feeds["bob"].frames()) == 3 && len(feeds["alice"].frames()) == 4
	})
	if id := gina2.frames()[1].PageID; id != "" {
		t.Fatalf("permissions.changed leaked a hidden page id to gina: %s", id)
	}
	if id := feeds["bob"].frames()[2].PageID; id != "" {
		t.Fatalf("permissions.changed leaked a private page id to bob: %s", id)
	}
	if feeds["alice"].frames()[3].PageID != secret.String() {
		t.Fatal("the page's owner should see the id")
	}

	// access is re-evaluated after permissions.changed: bob gets access to the secret page
	f.Grant("secret", "bob", "view")
	pub(events.PermissionsChanged, secret, func(e *events.Event) { e.Audience = events.AudienceAll })
	pub(events.PageUpdated, secret)
	waitFor(t, "bob to see the secret page after being granted", func() bool {
		types := feeds["bob"].types()
		return len(types) == 5 && types[4] == events.PageUpdated
	})

	// member.changed only goes to non-guests
	b.Publish(events.Event{Type: events.MemberChanged, WorkspaceID: f.WS, ActorID: owner, Data: map[string]any{"userId": gina.String()}})
	waitFor(t, "member.changed", func() bool { return len(feeds["alice"].frames()) == 7 })
	settle()
	if last := gina2.types(); last[len(last)-1] == events.MemberChanged {
		t.Fatal("guests must not receive member.changed")
	}

	// explicit recipients (page.deleted): the page no longer exists, the publisher decides
	b.Publish(events.Event{Type: events.PageDeleted, WorkspaceID: f.WS, PageID: uuid.New(), ActorID: owner, Recipients: []uuid.UUID{alice}})
	waitFor(t, "page.deleted for alice", func() bool {
		ts := feeds["alice"].types()
		return ts[len(ts)-1] == events.PageDeleted
	})
	settle()
	if ts := feeds["bob"].types(); ts[len(ts)-1] == events.PageDeleted {
		t.Fatal("page.deleted must only reach the listed recipients")
	}

	// comment events (wave 2) follow page visibility; plain data is passed through
	b.Publish(events.Event{Type: events.CommentCreated, WorkspaceID: f.WS, PageID: child, ActorID: alice, Data: map[string]any{"threadId": "t1"}})
	waitFor(t, "comment.created for gina (view on child)", func() bool {
		ts := gina2.types()
		return ts[len(ts)-1] == events.CommentCreated
	})
	if gina2.frames()[len(gina2.frames())-1].Data["threadId"] != "t1" {
		t.Fatal("event data lost")
	}

	// a removed member's stream is closed on the next event
	f.Exec(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, f.WS, bob)
	pub(events.PageUpdated, shared)
	select {
	case err := <-feeds["bob"].done:
		if err != events.ErrClosed {
			t.Fatalf("bob's stream ended with %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("bob's stream should be closed once he is no longer a member")
	}
}

func TestHeartbeat(t *testing.T) {
	f := testutil.NewFixture(t)
	u := f.Member("owen", "owner")
	b := events.NewBroker(f.Q, slog.New(slog.NewTextHandler(io.Discard, nil)))
	fd := newFeed(t, b, f.WS, u, 30*time.Millisecond)
	waitFor(t, "two pings", func() bool { return strings.Count(fd.text(), ": ping\n\n") >= 2 })
}

func TestCloseHelpersAndOverflow(t *testing.T) {
	f := testutil.NewFixture(t)
	u1, u2 := f.Member("a", "owner"), f.Member("b", "member")
	b := events.NewBroker(f.Q, slog.New(slog.NewTextHandler(io.Discard, nil)))

	s1, s2 := uuid.New(), uuid.New()
	sub1 := b.Subscribe(f.WS, u1, s1)
	sub2 := b.Subscribe(f.WS, u2, s2)
	if got := b.SubscriberIDs(f.WS); len(got) != 2 {
		t.Fatalf("subscribers = %v", got)
	}
	serve := func(sub *events.Subscription) chan error {
		ch := make(chan error, 1)
		go func() { ch <- sub.Serve(context.Background(), io.Discard, func() error { return nil }, time.Hour) }()
		return ch
	}
	d1, d2 := serve(sub1), serve(sub2)
	b.CloseSession(s1, "test")
	if err := <-d1; err != events.ErrClosed {
		t.Fatalf("CloseSession: %v", err)
	}
	b.CloseUser(u2, s2, "test") // spared session
	select {
	case <-d2:
		t.Fatal("CloseUser must spare the excepted session")
	case <-time.After(100 * time.Millisecond):
	}
	b.CloseUser(u2, uuid.Nil, "test")
	if err := <-d2; err != events.ErrClosed {
		t.Fatalf("CloseUser: %v", err)
	}

	// a subscriber that never reads is dropped instead of blocking publishers or growing memory
	slow := b.Subscribe(f.WS, u1, uuid.New())
	for i := 0; i < 1000; i++ {
		b.Publish(events.Event{Type: events.PageUpdated, WorkspaceID: f.WS})
	}
	if err := slow.Serve(context.Background(), io.Discard, func() error { return nil }, time.Hour); err != events.ErrClosed {
		t.Fatalf("overflowing subscriber: %v", err)
	}

	// workspace-wide close and shutdown
	w := b.Subscribe(f.WS, u1, uuid.New())
	b.CloseWorkspace(f.WS, "deleted")
	if err := w.Serve(context.Background(), io.Discard, func() error { return nil }, time.Hour); err != events.ErrClosed {
		t.Fatalf("CloseWorkspace: %v", err)
	}
	b.Shutdown()
	late := b.Subscribe(f.WS, u1, uuid.New())
	if err := late.Serve(context.Background(), io.Discard, func() error { return nil }, time.Hour); err != events.ErrClosed {
		t.Fatalf("subscribe after shutdown: %v", err)
	}
}
