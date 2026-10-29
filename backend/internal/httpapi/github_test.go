package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/githubsync"
)

// applyingCollab is a collab double that also "edits documents": it stores the Markdown the way collab's
// content push would.
type applyingCollab struct {
	*collabRecorder
	q *sqlcgen.Queries
}

func (a applyingCollab) ApplyMarkdown(ctx context.Context, req collabclient.ApplyRequest) (string, error) {
	err := a.q.UpsertPageContent(ctx, sqlcgen.UpsertPageContentParams{PageID: req.PageID, Markdown: req.Markdown, Plaintext: req.Markdown, Blocks: []byte("[]")})
	if err != nil {
		return "", err
	}
	editor := req.EditorID
	return req.Markdown, a.q.TouchPageEdited(ctx, sqlcgen.TouchPageEditedParams{ID: req.PageID, EditorID: &editor})
}

// miniGitHub serves one repository, acme/site, with a single open issue.
type miniGitHub struct {
	mu      sync.Mutex
	state   string
	patches int
	srv     *httptest.Server
}

func newMiniGitHub(t *testing.T) *miniGitHub {
	g := &miniGitHub{state: "open"}
	issue := func() map[string]any {
		return map[string]any{
			"number": 7, "title": "Login is broken", "body": "Steps to reproduce", "state": g.state,
			"html_url": "https://github.com/acme/site/issues/7", "updated_at": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339),
		}
	}
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/acme/site", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"full_name": "acme/site", "has_issues": true})
	})
	mux.HandleFunc("GET /repos/acme/site/issues", func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		reply(w, []any{issue()})
	})
	mux.HandleFunc("GET /repos/acme/site/issues/comments", func(w http.ResponseWriter, r *http.Request) { reply(w, []any{}) })
	mux.HandleFunc("PATCH /repos/acme/site/issues/7", func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		var in struct{ State *string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.State != nil {
			g.state = *in.State
		}
		g.patches++
		reply(w, issue())
	})
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	return g
}

func (g *miniGitHub) current() (state string, patches int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.state, g.patches
}

func TestGitHubIntegrationThroughTheAPI(t *testing.T) {
	gh := newMiniGitHub(t)
	e := newEnv(t, func(o *envOpts) {
		o.githubBase = gh.srv.URL
		o.collab = func(pool *pgxpool.Pool) collabclient.Disconnecter {
			return applyingCollab{collabRecorder: &collabRecorder{}, q: sqlcgen.New(pool)}
		}
	})
	admin, ws := e.setupAdmin()
	member, _ := e.newUser(admin, ws, "member", "Mia")
	guest, _ := e.newUser(admin, ws, "guest", "Gus")
	integ := wsPath(ws, "/integrations/github")

	// Only owners/admins manage connections; the session is required.
	e.client().mustStatus(e.client().get(integ), 401)
	member.mustStatus(member.get(integ), 403)
	member.mustStatus(member.post(integ, map[string]any{"repository": "acme/site", "token": "ghp_x"}), 403)
	admin.mustStatus(admin.post(integ, map[string]any{"repository": "nope", "token": "ghp_x"}), 422)
	admin.mustStatus(admin.post(integ, map[string]any{"repository": "acme/other", "token": "ghp_x"}), 422)

	created := admin.mustStatus(admin.post(integ, map[string]any{"repository": "acme/site", "token": "ghp_super_secret"}), 201)
	if bytes.Contains(created.body, []byte("ghp_super_secret")) {
		t.Fatal("the token is echoed back")
	}
	conn := created.m()
	connID := conn["id"].(string)
	if conn["repository"] != "acme/site" || conn["backfilled"] != false ||
		conn["webhookUrl"] != publicURL+"/api/integrations/github/webhook/"+connID || len(conn["webhookSecret"].(string)) != 64 {
		t.Fatalf("connection = %v", conn)
	}
	admin.mustStatus(admin.post(integ, map[string]any{"repository": "acme/site", "token": "ghp_x"}), 409)
	if list := admin.mustStatus(admin.get(integ), 200).list(); len(list) != 1 || bytes.Contains(mustJSON(t, list), []byte("ghp_")) {
		t.Fatalf("list = %v", list)
	}

	// The worker imports the existing issue.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.server.RunGitHubSync(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })

	var pageID string
	waitFor(t, "the issue to be imported", func() bool {
		refs := member.get(wsPath(ws, "/github-issues")).list()
		if len(refs) != 1 {
			return false
		}
		pageID = refs[0]["pageId"].(string)
		return refs[0]["number"] == float64(7) && refs[0]["repository"] == "acme/site" && refs[0]["state"] == "open"
	})

	detail := member.mustStatus(member.get("/pages/"+pageID), 200).m()
	link, _ := detail["github"].(map[string]any)
	if link == nil || link["number"] != float64(7) || link["state"] != "open" || link["url"] != "https://github.com/acme/site/issues/7" || link["lastSyncedAt"] == nil {
		t.Fatalf("page detail github = %v", detail["github"])
	}
	if page := detail["page"].(map[string]any); page["title"] != "Login is broken" || page["icon"] != "🟢" {
		t.Fatalf("page = %v", page)
	}
	plain := admin.page(ws, "Not synced", nil)
	if d := admin.mustStatus(admin.get("/pages/"+plain.String()), 200).m(); d["github"] != nil {
		t.Fatalf("an ordinary page reports a GitHub link: %v", d["github"])
	}
	if refs := guest.mustStatus(guest.get(wsPath(ws, "/github-issues")), 200).list(); len(refs) != 0 {
		t.Fatalf("a guest without access sees %v", refs)
	}

	// Closing from Hostidian reaches GitHub.
	guest.mustStatus(guest.put("/pages/"+pageID+"/github/state", map[string]any{"state": "closed"}), 404)
	member.mustStatus(member.put("/pages/"+pageID+"/github/state", map[string]any{"state": "bogus"}), 422)
	closed := member.mustStatus(member.put("/pages/"+pageID+"/github/state", map[string]any{"state": "closed"}), 200).m()
	if st, patches := gh.current(); closed["state"] != "closed" || st != "closed" || patches != 1 {
		t.Fatalf("state=%v github=%s patches=%d", closed["state"], st, patches)
	}
	admin.mustStatus(admin.put("/pages/"+plain.String()+"/github/state", map[string]any{"state": "closed"}), 404)

	// Pause, sync now, disconnect.
	admin.mustStatus(admin.patch("/integrations/github/"+connID, map[string]any{"enabled": false}), 200)
	admin.mustStatus(admin.post("/integrations/github/"+connID+"/sync", nil), 202)
	member.mustStatus(member.post("/integrations/github/"+connID+"/sync", nil), 404)
	member.mustStatus(member.delete("/integrations/github/"+connID), 404)
	admin.mustStatus(admin.delete("/integrations/github/"+connID), 204)
	admin.mustStatus(admin.delete("/integrations/github/"+connID), 404)
	if d := member.mustStatus(member.get("/pages/"+pageID), 200).m(); d["github"] != nil {
		t.Fatalf("link survived disconnect: %v", d["github"])
	}
}

// postWebhook sends a delivery the way GitHub does: no cookie, no Origin.
func postWebhook(t *testing.T, e *env, connID, event, signature string, body []byte) int {
	t.Helper()
	req, err := http.NewRequest("POST", e.ts.URL+"/api/integrations/github/webhook/"+connID, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", event)
	if signature != "" {
		req.Header.Set("X-Hub-Signature-256", signature)
	}
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestGitHubWebhookEndpoint(t *testing.T) {
	gh := newMiniGitHub(t)
	e := newEnv(t, func(o *envOpts) { o.githubBase = gh.srv.URL })
	admin, ws := e.setupAdmin()
	conn := admin.mustStatus(admin.post(wsPath(ws, "/integrations/github"), map[string]any{"repository": "acme/site", "token": "ghp_x"}), 201).m()
	id, secret := conn["id"].(string), conn["webhookSecret"].(string)
	body := []byte(`{"action":"edited","repository":{"full_name":"acme/site"}}`)

	if got := postWebhook(t, e, id, "issues", githubsync.Sign(secret, body), body); got != http.StatusAccepted {
		t.Fatalf("valid delivery = %d", got)
	}
	if got := postWebhook(t, e, id, "issues", githubsync.Sign("wrong", body), body); got != http.StatusUnauthorized {
		t.Fatalf("forged signature = %d", got)
	}
	if got := postWebhook(t, e, id, "issues", "", body); got != http.StatusUnauthorized {
		t.Fatalf("unsigned delivery = %d", got)
	}
	if got := postWebhook(t, e, uuid.NewString(), "issues", githubsync.Sign(secret, body), body); got != http.StatusNotFound {
		t.Fatalf("unknown connection = %d", got)
	}
	if got := postWebhook(t, e, "not-a-uuid", "issues", githubsync.Sign(secret, body), body); got != http.StatusNotFound {
		t.Fatalf("malformed id = %d", got)
	}
	if got := postWebhook(t, e, id, "ping", githubsync.Sign(secret, body), body); got != http.StatusAccepted {
		t.Fatalf("ping = %d", got)
	}
	big := bytes.Repeat([]byte("x"), 6<<20)
	if got := postWebhook(t, e, id, "issues", githubsync.Sign(secret, big), big); got != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized delivery = %d", got)
	}
	var requested bool
	if err := e.pool.QueryRow(context.Background(), `SELECT sync_requested_at IS NOT NULL FROM github_connections WHERE id = $1`, id).Scan(&requested); err != nil || !requested {
		t.Fatalf("delivery did not schedule a sync: %v %v", requested, err)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
