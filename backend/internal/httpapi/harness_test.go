package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/auth"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/config"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/deps"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi"
	"hostidian/backend/internal/testutil"
)

func TestMain(m *testing.M) { os.Exit(testutil.Run(m)) }

const publicURL = "http://localhost:3000"

// fakeClock lets tests move time (rate limiter windows).
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// collabRecorder captures the disconnect calls the services make.
type collabRecorder struct {
	mu    sync.Mutex
	calls []collabclient.DisconnectRequest
}

func (c *collabRecorder) Disconnect(req collabclient.DisconnectRequest) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, req)
}

func (c *collabRecorder) snapshot() []collabclient.DisconnectRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]collabclient.DisconnectRequest(nil), c.calls...)
}

func (c *collabRecorder) reset() {
	c.mu.Lock()
	c.calls = nil
	c.mu.Unlock()
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type env struct {
	t      *testing.T
	cfg    *config.Config
	pool   *pgxpool.Pool
	q      *sqlcgen.Queries
	server *httpapi.Server
	ts     *httptest.Server
	broker *events.Broker
	collab *collabRecorder
	clock  *fakeClock
}

type envOpts struct {
	configure func(env map[string]string)
	hasher    *auth.Hasher
	oidc      *http.Client
	// githubBase points the GitHub sync at a fake API.
	githubBase string
	// collab replaces the disconnect recorder (it can also implement collabclient.Applier).
	collab func(*pgxpool.Pool) collabclient.Disconnecter
}

func newEnv(t *testing.T, opts ...func(*envOpts)) *env {
	t.Helper()
	var o envOpts
	for _, f := range opts {
		f(&o)
	}
	pool := testutil.NewDB(t)
	vars := map[string]string{
		"DATABASE_URL": "postgres://unused", "COLLAB_JWT_SECRET": "collab-secret-for-tests-0123456789",
		"INTERNAL_TOKEN": "internal-token-for-tests-0123456789", "APP_SECRET": "app-secret-for-tests-0123456789",
		"PUBLIC_URL": publicURL, "ALLOWED_ORIGINS": "http://allowed.test",
	}
	if o.configure != nil {
		o.configure(vars)
	}
	cfg, err := config.FromEnv(func(k string) string { return vars[k] })
	if err != nil {
		t.Fatal(err)
	}
	// Server logs are only shown when the test fails.
	logs := &lockedBuffer{}
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("server log:\n%s", logs.String())
		}
	})
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	q := sqlcgen.New(pool)
	broker := events.NewBroker(q, log)
	t.Cleanup(broker.Shutdown)
	rec := &collabRecorder{}
	clock := &fakeClock{t: time.Now()}
	hasher := o.hasher
	if hasher == nil {
		hasher = auth.NewHasher(auth.HashParams{MemoryKiB: 64, Time: 1, Threads: 1}) // fast; params are covered in auth tests
	}
	var collab collabclient.Disconnecter = rec
	if o.collab != nil {
		collab = o.collab(pool)
	}
	srv, err := httpapi.NewServer(&deps.Deps{Config: cfg, Log: log, Pool: pool, Q: q, Broker: broker, Collab: collab}, httpapi.Options{
		Hasher: hasher, Now: clock.Now, OIDCClient: o.oidc, GitHubAPIBase: o.githubBase,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &env{t: t, cfg: cfg, pool: pool, q: q, server: srv, ts: ts, broker: broker, collab: rec, clock: clock}
}

// ---------------------------------------------------------------- client

type client struct {
	e      *env
	cookie string // "name=value" of the session cookie
	origin string
	name   string
}

func (e *env) client() *client { return &client{e: e, origin: publicURL} }

type resp struct {
	t       *testing.T
	status  int
	body    []byte
	header  http.Header
	cookies []*http.Cookie
}

func (r *resp) json(into any) {
	r.t.Helper()
	if err := json.Unmarshal(r.body, into); err != nil {
		r.t.Fatalf("decode response %q: %v", r.body, err)
	}
}

func (r *resp) m() map[string]any {
	r.t.Helper()
	var m map[string]any
	r.json(&m)
	return m
}

func (r *resp) list() []map[string]any {
	r.t.Helper()
	var l []map[string]any
	r.json(&l)
	return l
}

// errCode returns error.code of an envelope response.
func (r *resp) errCode() string {
	r.t.Helper()
	var env struct {
		Error struct {
			Code    string            `json:"code"`
			Message string            `json:"message"`
			Details map[string]string `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(r.body, &env); err != nil || env.Error.Code == "" {
		r.t.Fatalf("not an error envelope (status %d): %q", r.status, r.body)
	}
	return env.Error.Code
}

func (c *client) request(method, path string, body any, mods ...func(*http.Request)) *resp {
	c.e.t.Helper()
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		rd = strings.NewReader(b)
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			c.e.t.Fatal(err)
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, c.e.ts.URL+"/api"+path, rd)
	if err != nil {
		c.e.t.Fatal(err)
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.origin != "" {
		req.Header.Set("Origin", c.origin)
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	for _, m := range mods {
		m(req)
	}
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	out := &resp{t: c.e.t, status: res.StatusCode, body: data, header: res.Header, cookies: res.Cookies()}
	for _, ck := range out.cookies {
		if ck.Name == auth.CookieName {
			if ck.MaxAge < 0 || ck.Value == "" {
				c.cookie = ""
			} else {
				c.cookie = ck.Name + "=" + ck.Value
			}
		}
	}
	return out
}

func (c *client) get(path string) *resp          { return c.request("GET", path, nil) }
func (c *client) post(path string, b any) *resp  { return c.request("POST", path, b) }
func (c *client) patch(path string, b any) *resp { return c.request("PATCH", path, b) }
func (c *client) put(path string, b any) *resp   { return c.request("PUT", path, b) }
func (c *client) delete(path string) *resp       { return c.request("DELETE", path, nil) }
func (c *client) mustStatus(r *resp, want int) *resp {
	c.e.t.Helper()
	if r.status != want {
		c.e.t.Fatalf("status = %d, want %d; body: %s", r.status, want, r.body)
	}
	return r
}

// ---------------------------------------------------------------- scenario helpers

const testPassword = "correct horse battery"

// setupAdmin runs POST /setup and returns the logged-in admin client and its workspace id.
func (e *env) setupAdmin() (*client, uuid.UUID) {
	e.t.Helper()
	c := e.client()
	c.name = "Admin"
	r := c.mustStatus(c.post("/setup", map[string]any{
		"name": "Admin", "email": "admin@example.com", "password": testPassword, "workspaceName": "Acme",
	}), 201)
	me := r.m()
	ws := me["workspaces"].([]any)[0].(map[string]any)["workspace"].(map[string]any)["id"].(string)
	return c, uuid.MustParse(ws)
}

// invite creates an invite in the workspace as c and returns its token.
func (c *client) invite(ws uuid.UUID, role string, email string) string {
	c.e.t.Helper()
	body := map[string]any{"role": role}
	if email != "" {
		body["email"] = email
	}
	r := c.mustStatus(c.post("/workspaces/"+ws.String()+"/invites", body), 201)
	return r.m()["token"].(string)
}

// newUser registers a user through an invite from admin and returns their client and id.
func (e *env) newUser(admin *client, ws uuid.UUID, role, name string) (*client, uuid.UUID) {
	e.t.Helper()
	token := admin.invite(ws, role, "")
	u := e.client()
	u.name = name
	r := u.mustStatus(u.post("/auth/register", map[string]any{
		"name": name, "email": strings.ToLower(name) + "@example.com", "password": testPassword, "inviteToken": token,
	}), 201)
	return u, uuid.MustParse(r.m()["user"].(map[string]any)["id"].(string))
}

// createPage creates a page via the API and returns its id.
func (c *client) createPage(ws uuid.UUID, body map[string]any) uuid.UUID {
	c.e.t.Helper()
	r := c.mustStatus(c.post("/workspaces/"+ws.String()+"/pages", body), 201)
	return uuid.MustParse(r.m()["id"].(string))
}

func (c *client) page(ws uuid.UUID, title string, parent *uuid.UUID) uuid.UUID {
	c.e.t.Helper()
	body := map[string]any{"title": title}
	if parent != nil {
		body["parentId"] = parent.String()
	}
	return c.createPage(ws, body)
}

func ctx() context.Context { return context.Background() }
