package collabclient

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDisconnectSendsAuthenticatedRequest(t *testing.T) {
	var mu sync.Mutex
	var got []map[string]string
	var auth, path, method string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		got = append(got, body)
		auth, path, method = r.Header.Get("Authorization"), r.URL.Path, r.Method
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]int{"closed": 1})
	}))
	defer srv.Close()

	c := New(srv.URL+"/", "tok", slog.New(slog.NewTextHandler(io.Discard, nil)))
	page, user := uuid.New(), uuid.New()
	if err := c.DisconnectSync(context.Background(), DisconnectRequest{PageID: page, UserID: user}); err != nil {
		t.Fatal(err)
	}
	c.Disconnect(DisconnectRequest{PageID: page, Reason: "page_archived"})
	c.Wait()

	mu.Lock()
	defer mu.Unlock()
	if method != "POST" || path != "/internal/disconnect" || auth != "Bearer tok" {
		t.Fatalf("request: %s %s auth=%q", method, path, auth)
	}
	if len(got) != 2 || got[0]["pageId"] != page.String() || got[0]["userId"] != user.String() || got[0]["reason"] != "permissions_changed" ||
		got[1]["reason"] != "page_archived" || got[1]["userId"] != "" {
		t.Fatalf("bodies = %v", got)
	}
}

func TestDisabledClientIsANoop(t *testing.T) {
	c := New("", "tok", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if c.Enabled() {
		t.Fatal("empty URL means disabled")
	}
	c.Disconnect(DisconnectRequest{PageID: uuid.New()}) // must not panic or block
	if err := c.DisconnectSync(context.Background(), DisconnectRequest{PageID: uuid.New()}); err != nil {
		t.Fatal(err)
	}
	c.Wait()
}

func TestFailuresAreReportedNotFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", 500) }))
	defer srv.Close()
	c := New(srv.URL, "tok", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := c.DisconnectSync(context.Background(), DisconnectRequest{PageID: uuid.New()}); err == nil {
		t.Fatal("a 500 must be an error")
	}
	if err := c.DisconnectSync(context.Background(), DisconnectRequest{}); err == nil {
		t.Fatal("a request without page and user is invalid")
	}
	c.Disconnect(DisconnectRequest{PageID: uuid.New()}) // logged, never panics
	done := make(chan struct{})
	go func() { c.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait hung")
	}

	dead := New("http://127.0.0.1:1", "tok", slog.New(slog.NewTextHandler(io.Discard, nil)))
	dead.Disconnect(DisconnectRequest{UserID: uuid.New()})
	dead.Wait() // connection refused is logged, not fatal
}
