package githubsync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/comments"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/pages"
	"hostidian/backend/internal/testutil"
)

func TestMain(m *testing.M) { os.Exit(testutil.Run(m)) }

// ---------------------------------------------------------------- fake GitHub

type ghIssue struct {
	Number  int32
	Title   string
	Body    string
	State   string
	PR      bool
	Updated time.Time
}

type ghComment struct {
	ID      int64
	Issue   int32
	Body    string
	Login   string
	Updated time.Time
}

// fakeGH is an in-memory GitHub: just enough of the REST API for the sync.
type fakeGH struct {
	t        *testing.T
	mu       sync.Mutex
	clock    time.Time
	issues   map[int32]*ghIssue
	comments []*ghComment
	nextID   int64
	calls    map[string]int
	srv      *httptest.Server
	// fail makes the next request of that kind answer with the status ("patch issue": 422).
	fail           map[string]int
	issuesDisabled bool
}

func newFakeGH(t *testing.T) *fakeGH {
	g := &fakeGH{t: t, clock: time.Now().Add(-24 * time.Hour).Truncate(time.Second), issues: map[int32]*ghIssue{}, calls: map[string]int{}, fail: map[string]int{}, nextID: 1000}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/{o}/{r}", g.getRepo)
	mux.HandleFunc("GET /repos/{o}/{r}/issues", g.listIssues)
	mux.HandleFunc("POST /repos/{o}/{r}/issues", g.createIssue)
	mux.HandleFunc("GET /repos/{o}/{r}/issues/comments", g.listComments)
	mux.HandleFunc("GET /repos/{o}/{r}/issues/{n}", g.getIssue)
	mux.HandleFunc("PATCH /repos/{o}/{r}/issues/{n}", g.patchIssue)
	mux.HandleFunc("POST /repos/{o}/{r}/issues/{n}/comments", g.createComment)
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGH) client(token string) *Client { return NewClient(token).WithBase(g.srv.URL) }

// tick advances the fake clock one second and returns it (GitHub timestamps have second resolution).
func (g *fakeGH) tick() time.Time {
	g.clock = g.clock.Add(time.Second)
	return g.clock
}

func (g *fakeGH) count(kind string) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls[kind]
}

// addIssue creates an issue as if someone did it on github.com.
func (g *fakeGH) addIssue(title, body string) *ghIssue {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := int32(len(g.issues) + 1)
	is := &ghIssue{Number: n, Title: title, Body: body, State: "open", Updated: g.tick()}
	g.issues[n] = is
	return is
}

// edit changes an issue as if someone did it on github.com.
func (g *fakeGH) edit(n int32, f func(*ghIssue)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	f(g.issues[n])
	g.issues[n].Updated = g.tick()
}

func (g *fakeGH) comment(n int32, login, body string) *ghComment {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.nextID++
	c := &ghComment{ID: g.nextID, Issue: n, Body: body, Login: login, Updated: g.tick()}
	g.comments = append(g.comments, c)
	return c
}

func (g *fakeGH) get(n int32) ghIssue {
	g.mu.Lock()
	defer g.mu.Unlock()
	return *g.issues[n]
}

func (g *fakeGH) allComments() []ghComment {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]ghComment, 0, len(g.comments))
	for _, c := range g.comments {
		out = append(out, *c)
	}
	return out
}

func (g *fakeGH) issueJSON(is *ghIssue) map[string]any {
	m := map[string]any{
		"number": is.Number, "title": is.Title, "state": is.State, "updated_at": is.Updated.Format(time.RFC3339),
		"html_url": fmt.Sprintf("https://github.com/acme/site/issues/%d", is.Number),
	}
	if is.Body != "" {
		m["body"] = is.Body
	} else {
		m["body"] = nil
	}
	if is.PR {
		m["pull_request"] = map[string]any{}
	}
	return m
}

func (g *fakeGH) commentJSON(c *ghComment) map[string]any {
	return map[string]any{
		"id": c.ID, "body": c.Body, "updated_at": c.Updated.Format(time.RFC3339),
		"issue_url": fmt.Sprintf("https://api.github.com/repos/acme/site/issues/%d", c.Issue),
		"user":      map[string]any{"login": c.Login},
	}
}

func (g *fakeGH) begin(w http.ResponseWriter, kind string) bool {
	g.calls[kind]++
	if status := g.fail[kind]; status != 0 {
		delete(g.fail, kind)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"message":"simulated failure"}`))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func since(r *http.Request) time.Time {
	t, _ := time.Parse(time.RFC3339, r.URL.Query().Get("since"))
	return t
}

func (g *fakeGH) getRepo(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "get repo") {
		return
	}
	// GitHub resolves owner and repository names case-insensitively.
	if !strings.EqualFold(r.PathValue("o"), "acme") || !strings.EqualFold(r.PathValue("r"), "site") {
		writeJSON(w, 404, map[string]string{"message": "Not Found"})
		return
	}
	writeJSON(w, 200, map[string]any{"full_name": "acme/site", "has_issues": !g.issuesDisabled})
}

func (g *fakeGH) listIssues(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "list issues") {
		return
	}
	s := since(r)
	out := []map[string]any{}
	for n := int32(1); n <= int32(len(g.issues)); n++ {
		if is := g.issues[n]; !is.Updated.Before(s) {
			out = append(out, g.issueJSON(is))
		}
	}
	// oldest update first, like sort=updated&direction=asc
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j]["updated_at"].(string) < out[i]["updated_at"].(string) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	writeJSON(w, 200, out)
}

func (g *fakeGH) getIssue(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "get issue") {
		return
	}
	n, _ := strconv.Atoi(r.PathValue("n"))
	is, ok := g.issues[int32(n)]
	if !ok {
		writeJSON(w, 404, map[string]string{"message": "Not Found"})
		return
	}
	writeJSON(w, 200, g.issueJSON(is))
}

func (g *fakeGH) createIssue(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "create issue") {
		return
	}
	var in struct{ Title, Body string }
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &in)
	n := int32(len(g.issues) + 1)
	is := &ghIssue{Number: n, Title: in.Title, Body: in.Body, State: "open", Updated: g.tick()}
	g.issues[n] = is
	writeJSON(w, 201, g.issueJSON(is))
}

func (g *fakeGH) patchIssue(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "patch issue") {
		return
	}
	n, _ := strconv.Atoi(r.PathValue("n"))
	is, ok := g.issues[int32(n)]
	if !ok {
		writeJSON(w, 404, map[string]string{"message": "Not Found"})
		return
	}
	var in struct{ Title, Body, State *string }
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &in)
	if in.Title != nil {
		is.Title = *in.Title
	}
	if in.Body != nil {
		is.Body = *in.Body
	}
	if in.State != nil {
		is.State = *in.State
	}
	is.Updated = g.tick()
	writeJSON(w, 200, g.issueJSON(is))
}

func (g *fakeGH) listComments(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "list comments") {
		return
	}
	s := since(r)
	out := []map[string]any{}
	for _, c := range g.comments {
		if !c.Updated.Before(s) {
			out = append(out, g.commentJSON(c))
		}
	}
	writeJSON(w, 200, out)
}

func (g *fakeGH) createComment(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.begin(w, "create comment") {
		return
	}
	n, _ := strconv.Atoi(r.PathValue("n"))
	var in struct{ Body string }
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &in)
	g.nextID++
	c := &ghComment{ID: g.nextID, Issue: int32(n), Body: in.Body, Login: "token-owner", Updated: g.tick()}
	g.comments = append(g.comments, c)
	writeJSON(w, 201, g.commentJSON(c))
}

// ---------------------------------------------------------------- fake collab

// fakeApplier stands in for the collab service: it stores the Markdown the way collab's content push would.
type fakeApplier struct {
	q     *sqlcgen.Queries
	mu    sync.Mutex
	calls int
	// normalize imitates the editor's lossy Markdown round trip (bullet style, spacing, …).
	normalize func(string) string
	err       error
}

func (a *fakeApplier) ApplyMarkdown(ctx context.Context, req collabclient.ApplyRequest) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	if a.err != nil {
		return "", a.err
	}
	md := req.Markdown
	if a.normalize != nil {
		md = a.normalize(md)
	}
	if err := a.q.UpsertPageContent(ctx, sqlcgen.UpsertPageContentParams{PageID: req.PageID, Markdown: md, Plaintext: md, Blocks: []byte("[]")}); err != nil {
		return "", err
	}
	editor := req.EditorID
	return md, a.q.TouchPageEdited(ctx, sqlcgen.TouchPageEditedParams{ID: req.PageID, EditorID: &editor})
}

func (a *fakeApplier) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.calls
}

// ---------------------------------------------------------------- scenario

type scenario struct {
	t       *testing.T
	f       *testutil.Fixture
	gh      *fakeGH
	app     *fakeApplier
	engine  *Engine
	pages   *pages.Service
	cmts    *comments.Service
	owner   uuid.UUID
	conn    sqlcgen.GithubConnection
	vault   *Vault
	broker  *events.Broker
	nowSkew time.Duration
}

// newScenario builds a workspace owned by "owner", a fake GitHub with a connection to acme/site, and an engine
// whose clock runs an hour ahead so every edit counts as settled.
func newScenario(t *testing.T) *scenario {
	t.Helper()
	f := testutil.NewFixture(t)
	owner := f.Member("owner", "owner")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	broker := events.NewBroker(f.Q, log)
	t.Cleanup(broker.Shutdown)
	vault, err := NewVault("test-app-secret-0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	gh := newFakeGH(t)
	app := &fakeApplier{q: f.Q}
	pg := pages.NewService(pages.Options{Pool: f.Pool, Broker: broker, Collab: collabclient.Noop{}, Log: log, CollabSecret: "x", CollabPublicURL: "ws://x"})
	cm := comments.NewService(comments.Options{Q: f.Q, Pool: f.Pool, Broker: broker, Log: log})
	s := &scenario{t: t, f: f, gh: gh, app: app, pages: pg, cmts: cm, owner: owner, vault: vault, broker: broker, nowSkew: time.Hour}
	s.engine = NewEngine(Options{
		Pool: f.Pool, Q: f.Q, Vault: vault, Pages: pg, Comments: cm, Collab: app, Broker: broker,
		PublicURL: "https://notes.example.com", Log: log,
		Now:       func() time.Time { return time.Now().Add(s.nowSkew) },
		NewClient: gh.client,
	})
	token, _ := vault.Seal([]byte("ghp_test"))
	secret, _ := vault.Seal([]byte("whsec"))
	s.conn, err = f.Q.InsertGithubConnection(context.Background(), sqlcgen.InsertGithubConnectionParams{
		WorkspaceID: f.WS, Owner: "acme", Repo: "site", TokenEnc: token, WebhookSecretEnc: secret, SyncUserID: owner,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (s *scenario) sync(mode Mode) {
	s.t.Helper()
	if err := s.engine.Sync(context.Background(), s.conn.ID, mode); err != nil {
		s.t.Fatalf("sync: %v", err)
	}
}

func (s *scenario) both() { s.sync(Mode{Pull: true, Push: true}) }

// pageFor returns the page linked to an issue number.
func (s *scenario) pageFor(n int32) (sqlcgen.Page, sqlcgen.GithubIssueLink) {
	s.t.Helper()
	link, err := s.f.Q.GetGithubIssueLinkByNumber(context.Background(), sqlcgen.GetGithubIssueLinkByNumberParams{ConnectionID: s.conn.ID, IssueNumber: n})
	if err != nil {
		s.t.Fatalf("issue #%d has no page: %v", n, err)
	}
	p, err := s.f.Q.GetPage(context.Background(), link.PageID)
	if err != nil {
		s.t.Fatal(err)
	}
	return p, link
}

func (s *scenario) markdown(pageID uuid.UUID) string {
	c, err := s.f.Q.GetPageContent(context.Background(), pageID)
	if err != nil {
		return ""
	}
	return c.Markdown
}

// editLocal changes a page the way the editor and the rename box do.
func (s *scenario) editLocal(pageID uuid.UUID, title *string, markdown *string) {
	s.t.Helper()
	ctx := context.Background()
	if title != nil {
		if _, err := s.pages.Update(ctx, s.owner, pageID, pages.UpdateInput{Title: title}); err != nil {
			s.t.Fatal(err)
		}
	}
	if markdown != nil {
		if err := s.f.Q.UpsertPageContent(ctx, sqlcgen.UpsertPageContentParams{PageID: pageID, Markdown: *markdown, Plaintext: *markdown, Blocks: []byte("[]")}); err != nil {
			s.t.Fatal(err)
		}
		if err := s.f.Q.TouchPageEdited(ctx, sqlcgen.TouchPageEditedParams{ID: pageID, EditorID: &s.owner}); err != nil {
			s.t.Fatal(err)
		}
	}
}

func str(s string) *string { return &s }

func contains(s, sub string) bool { return strings.Contains(s, sub) }
