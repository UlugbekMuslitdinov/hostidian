package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// fakeCollab stands in for the collab service's /internal/apply-markdown: it keeps one Markdown string per
// page, applies replace/append/prepend to it and pushes the result to the API like the real service does.
type fakeCollab struct {
	t           *testing.T
	ts          *httptest.Server
	internalURL string
	mu          sync.Mutex
	docs        map[string]string
	editors     map[string]string
	calls       []map[string]string
}

func (f *fakeCollab) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/internal/apply-markdown" || r.Header.Get("Authorization") != "Bearer "+internalTokenForTests {
		http.Error(w, `{"error":{"code":"unauthorized","message":"no"}}`, http.StatusUnauthorized)
		return
	}
	var req map[string]string
	_ = json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	f.calls = append(f.calls, req)
	page := req["pageId"]
	switch req["mode"] {
	case "replace":
		f.docs[page] = req["markdown"]
	case "append":
		f.docs[page] = strings.TrimSpace(f.docs[page] + "\n\n" + req["markdown"])
	case "prepend":
		f.docs[page] = strings.TrimSpace(req["markdown"] + "\n\n" + f.docs[page])
	}
	f.editors[page] = req["editorId"]
	md := f.docs[page]
	f.mu.Unlock()

	var blocks []map[string]any
	for i, para := range strings.Split(md, "\n\n") {
		blocks = append(blocks, map[string]any{"id": "blk-" + string(rune('a'+i)), "type": "paragraph", "text": para})
	}
	push, _ := json.Marshal(map[string]any{
		"markdown": md, "plaintext": md, "blocks": blocks, "linkTargets": []string{}, "editorIds": []string{req["editorId"]},
	})
	put, _ := http.NewRequest(http.MethodPut, f.internalURL+"/internal/pages/"+page+"/content", bytes.NewReader(push))
	put.Header.Set("Content-Type", "application/json")
	put.Header.Set("Authorization", "Bearer "+internalTokenForTests)
	res, err := http.DefaultClient.Do(put)
	if err != nil || res.StatusCode != http.StatusNoContent {
		http.Error(w, `{"error":{"code":"not_found","message":"gone"}}`, http.StatusNotFound)
		return
	}
	res.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"markdown": md})
}

func (f *fakeCollab) lastCall() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return nil
	}
	return f.calls[len(f.calls)-1]
}

// mcpEnv is an environment whose collab URL points at a fake apply-markdown endpoint.
func mcpEnv(t *testing.T, extra ...func(map[string]string)) (*env, *fakeCollab) {
	t.Helper()
	f := &fakeCollab{t: t, docs: map[string]string{}, editors: map[string]string{}}
	f.ts = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.ts.Close)
	e := newEnv(t, func(o *envOpts) {
		o.configure = func(vars map[string]string) {
			vars["COLLAB_INTERNAL_URL"] = f.ts.URL
			for _, fn := range extra {
				fn(vars)
			}
		}
	})
	f.internalURL = e.internalServer().URL
	return e, f
}

// ---------------------------------------------------------------- token helpers

type tokenReq map[string]any

func (c *client) createToken(body tokenReq) (secret string, id string) {
	c.e.t.Helper()
	r := c.mustStatus(c.post("/auth/tokens", body), 201)
	m := r.m()
	return m["token"].(string), m["apiToken"].(map[string]any)["id"].(string)
}

// rawMCP posts one JSON-RPC message to /api/mcp with the given headers.
func rawMCP(t *testing.T, e *env, method string, body string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, e.ts.URL+"/api/mcp", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

const pingBody = `{"jsonrpc":"2.0","id":1,"method":"ping"}`

type bearerTransport struct{ token string }

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// agent is a connected official MCP client.
type agent struct {
	t       *testing.T
	session *sdk.ClientSession
}

func connectAgent(t *testing.T, e *env, token string) *agent {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "test-agent", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:             e.ts.URL + "/api/mcp",
		HTTPClient:           &http.Client{Transport: bearerTransport{token}},
		DisableStandaloneSSE: true,
		MaxRetries:           -1,
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return &agent{t: t, session: session}
}

// call invokes a tool and returns the parsed structured result plus the error text (empty on success).
func (a *agent) call(name string, args map[string]any) (map[string]any, string) {
	a.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := a.session.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		a.t.Fatalf("%s: protocol error: %v", name, err)
	}
	if res.IsError {
		var text strings.Builder
		for _, c := range res.Content {
			if tc, ok := c.(*sdk.TextContent); ok {
				text.WriteString(tc.Text)
			}
		}
		return nil, text.String()
	}
	raw, _ := json.Marshal(res.StructuredContent)
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		a.t.Fatalf("%s: structured content %s: %v", name, raw, err)
	}
	return out, ""
}

func (a *agent) must(name string, args map[string]any) map[string]any {
	a.t.Helper()
	out, errText := a.call(name, args)
	if errText != "" {
		a.t.Fatalf("%s failed: %s", name, errText)
	}
	return out
}

func (a *agent) mustFail(name string, args map[string]any, wantCode string) {
	a.t.Helper()
	out, errText := a.call(name, args)
	if errText == "" {
		a.t.Fatalf("%s succeeded (%v), want error %s", name, out, wantCode)
	}
	if !strings.HasPrefix(errText, wantCode+":") {
		a.t.Fatalf("%s error = %q, want code %s", name, errText, wantCode)
	}
}

func ids(list any, key string) []string {
	var out []string
	for _, item := range list.([]any) {
		out = append(out, item.(map[string]any)[key].(string))
	}
	return out
}

// ---------------------------------------------------------------- access token endpoints

func TestAPITokenLifecycle(t *testing.T) {
	e := newEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")

	// creation: the secret is shown once, the list never has it
	r := admin.mustStatus(admin.post("/auth/tokens", tokenReq{"name": "Claude Code", "scope": "write", "workspaceId": ws.String(), "expiresInDays": 30}), 201)
	created := r.m()
	secret := created["token"].(string)
	api := created["apiToken"].(map[string]any)
	if !strings.HasPrefix(secret, "hst_") || len(secret) != 4+43 {
		t.Fatalf("token format: %q", secret)
	}
	if api["prefix"] != secret[:10] || api["scope"] != "write" || api["workspaceId"] != ws.String() || api["expiresAt"] == nil {
		t.Fatalf("api token: %v", api)
	}
	if created["mcpUrl"] != publicURL+"/api/mcp" {
		t.Fatalf("mcpUrl = %v", created["mcpUrl"])
	}
	list := admin.mustStatus(admin.get("/auth/tokens"), 200)
	if strings.Contains(string(list.body), secret) || len(list.list()) != 1 {
		t.Fatalf("list leaks or is wrong: %s", list.body)
	}
	var stored []byte
	if err := e.pool.QueryRow(ctx(), "SELECT token_hash FROM api_tokens").Scan(&stored); err != nil || len(stored) != 32 || bytes.Contains(stored, []byte(secret)) {
		t.Fatalf("only a SHA-256 may be stored: %v len=%d", err, len(stored))
	}

	// tokens are per user, and revoking someone else's is a 404
	if got := bob.mustStatus(bob.get("/auth/tokens"), 200).list(); len(got) != 0 {
		t.Fatalf("bob sees %v", got)
	}
	id := api["id"].(string)
	bob.mustStatus(bob.delete("/auth/tokens/"+id), 404)
	bob.mustStatus(bob.delete("/auth/tokens/"+uuid.NewString()), 404)

	// validation
	for name, body := range map[string]tokenReq{
		"empty name":     {"name": "  ", "scope": "read"},
		"bad scope":      {"name": "x", "scope": "admin"},
		"zero expiry":    {"name": "x", "scope": "read", "expiresInDays": 0},
		"long expiry":    {"name": "x", "scope": "read", "expiresInDays": 366},
		"foreign wspace": {"name": "x", "scope": "read", "workspaceId": uuid.NewString()},
	} {
		if r := admin.post("/auth/tokens", body); r.status != 422 {
			t.Fatalf("%s: status %d: %s", name, r.status, r.body)
		}
	}
	// a workspace the caller is not in cannot be used to restrict a token
	other := admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Other"}), 201).m()["workspace"].(map[string]any)["id"].(string)
	bob.mustStatus(bob.post("/auth/tokens", tokenReq{"name": "x", "scope": "read", "workspaceId": other}), 422)

	// tokens are not credentials for the REST API, and cannot manage tokens
	for _, path := range []string{"/auth/me", "/auth/tokens", "/workspaces"} {
		anon := e.client()
		r := anon.request("GET", path, nil, func(req *http.Request) { req.Header.Set("Authorization", "Bearer "+secret) })
		if r.status != 401 {
			t.Fatalf("GET %s with a bearer token = %d, want 401", path, r.status)
		}
	}
	anon := e.client()
	if r := anon.request("POST", "/auth/tokens", tokenReq{"name": "x", "scope": "read"}, func(req *http.Request) { req.Header.Set("Authorization", "Bearer "+secret) }); r.status != 401 {
		t.Fatalf("a token created a token: %d", r.status)
	}

	admin.mustStatus(admin.delete("/auth/tokens/"+id), 204)
	admin.mustStatus(admin.delete("/auth/tokens/"+id), 404)
	if got := admin.mustStatus(admin.get("/auth/tokens"), 200).list(); len(got) != 0 {
		t.Fatalf("revoked token still listed: %v", got)
	}
}

func TestAPITokenLimitPerUser(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin()
	for i := 0; i < 50; i++ {
		admin.createToken(tokenReq{"name": "t", "scope": "read"})
	}
	admin.mustStatus(admin.post("/auth/tokens", tokenReq{"name": "one too many", "scope": "read"}), 409)
}

// ---------------------------------------------------------------- the MCP endpoint

func TestMCPEndpointAuthentication(t *testing.T) {
	e, _ := mcpEnv(t)
	admin, ws := e.setupAdmin()
	secret, id := admin.createToken(tokenReq{"name": "agent", "scope": "read"})

	ok := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + secret})
	if ok.StatusCode != 200 {
		b, _ := io.ReadAll(ok.Body)
		t.Fatalf("valid token: %d %s", ok.StatusCode, b)
	}

	expectUnauthorized := func(name string, headers map[string]string) {
		t.Helper()
		res := rawMCP(t, e, "POST", pingBody, headers)
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != 401 || res.Header.Get("WWW-Authenticate") != "Bearer" || !strings.Contains(string(body), `"unauthorized"`) {
			t.Fatalf("%s: status %d header %q body %s", name, res.StatusCode, res.Header.Get("WWW-Authenticate"), body)
		}
	}
	expectUnauthorized("no header", nil)
	expectUnauthorized("garbage", map[string]string{"Authorization": "Bearer hst_notarealtoken"})
	expectUnauthorized("wrong scheme", map[string]string{"Authorization": "Basic " + secret})
	expectUnauthorized("not our prefix", map[string]string{"Authorization": "Bearer " + strings.TrimPrefix(secret, "hst_")})
	// the session cookie is ignored on this endpoint
	expectUnauthorized("cookie only", map[string]string{"Cookie": admin.cookie, "Origin": publicURL})

	// foreign browser origins are refused even with a valid token; same-origin and no Origin are fine
	if res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + secret, "Origin": "http://evil.test"}); res.StatusCode != 403 {
		t.Fatalf("foreign origin = %d", res.StatusCode)
	}
	if res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + secret, "Origin": publicURL}); res.StatusCode != 200 {
		t.Fatalf("own origin = %d", res.StatusCode)
	}
	// stateless transport: no standalone streams
	if res := rawMCP(t, e, "GET", "", map[string]string{"Authorization": "Bearer " + secret, "Accept": "text/event-stream"}); res.StatusCode != 405 {
		t.Fatalf("GET = %d, want 405", res.StatusCode)
	}
	// request bodies are capped at 4 MiB
	big := `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"` + strings.Repeat("x", 5<<20) + `"}}`
	if res := rawMCP(t, e, "POST", big, map[string]string{"Authorization": "Bearer " + secret}); res.StatusCode != 413 {
		t.Fatalf("oversized body = %d, want 413", res.StatusCode)
	}

	// last use is recorded, but not on every call
	var lastUsed *time.Time
	if err := e.pool.QueryRow(ctx(), "SELECT last_used_at FROM api_tokens WHERE id = $1", id).Scan(&lastUsed); err != nil || lastUsed == nil {
		t.Fatalf("last_used_at not set: %v", err)
	}
	first := *lastUsed
	rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + secret})
	_ = e.pool.QueryRow(ctx(), "SELECT last_used_at FROM api_tokens WHERE id = $1", id).Scan(&lastUsed)
	if !lastUsed.Equal(first) {
		t.Fatalf("last_used_at moved within five minutes: %v -> %v", first, lastUsed)
	}
	var listed []map[string]any = admin.mustStatus(admin.get("/auth/tokens"), 200).list()
	if listed[0]["lastUsedAt"] == nil {
		t.Fatalf("list does not show lastUsedAt: %v", listed[0])
	}

	// revocation is immediate
	admin.mustStatus(admin.delete("/auth/tokens/"+id), 204)
	expectUnauthorized("revoked", map[string]string{"Authorization": "Bearer " + secret})

	// expiry
	expiring, expID := admin.createToken(tokenReq{"name": "short", "scope": "read", "expiresInDays": 1})
	if res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + expiring}); res.StatusCode != 200 {
		t.Fatalf("fresh expiring token = %d", res.StatusCode)
	}
	if _, err := e.pool.Exec(ctx(), "UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", expID); err != nil {
		t.Fatal(err)
	}
	expectUnauthorized("expired", map[string]string{"Authorization": "Bearer " + expiring})

	// a disabled user's tokens stop working
	bob, bobID := e.newUser(admin, ws, "member", "Bob")
	bobToken, _ := bob.createToken(tokenReq{"name": "bob", "scope": "read"})
	if res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + bobToken}); res.StatusCode != 200 {
		t.Fatalf("bob's token = %d", res.StatusCode)
	}
	admin.mustStatus(admin.patch("/admin/users/"+bobID.String(), map[string]any{"disabled": true}), 200)
	expectUnauthorized("disabled user", map[string]string{"Authorization": "Bearer " + bobToken})
}

func TestMCPDisabledAnswers404(t *testing.T) {
	e, _ := mcpEnv(t, func(v map[string]string) { v["MCP_ENABLED"] = "false" })
	admin, _ := e.setupAdmin()
	secret, _ := admin.createToken(tokenReq{"name": "agent", "scope": "read"})
	res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + secret})
	if res.StatusCode != 404 {
		t.Fatalf("MCP_ENABLED=false: %d, want 404", res.StatusCode)
	}
	if res := rawMCP(t, e, "POST", pingBody, nil); res.StatusCode != 404 {
		t.Fatalf("MCP_ENABLED=false without token: %d, want 404", res.StatusCode)
	}
}

func TestMCPRateLimitPerToken(t *testing.T) {
	e, _ := mcpEnv(t)
	admin, _ := e.setupAdmin()
	a, _ := admin.createToken(tokenReq{"name": "a", "scope": "read"})
	b, _ := admin.createToken(tokenReq{"name": "b", "scope": "read"})
	limited := 0
	for i := 0; i < 130; i++ {
		res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + a})
		if res.StatusCode == 429 {
			limited++
			if res.Header.Get("Retry-After") == "" {
				t.Fatal("429 without Retry-After")
			}
		}
	}
	if limited < 5 || limited > 10 {
		t.Fatalf("limited = %d of 130 requests, want about 10", limited)
	}
	// another token is unaffected
	if res := rawMCP(t, e, "POST", pingBody, map[string]string{"Authorization": "Bearer " + b}); res.StatusCode != 200 {
		t.Fatalf("second token = %d", res.StatusCode)
	}
}

func TestMCPToolsEndToEnd(t *testing.T) {
	e, collab := mcpEnv(t)
	admin, ws := e.setupAdmin()
	secret, _ := admin.createToken(tokenReq{"name": "agent", "scope": "write"})
	ag := connectAgent(t, e, secret)

	// discovery: tools with honest annotations
	tools, err := ag.session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*sdk.Tool{}
	for _, tool := range tools.Tools {
		byName[tool.Name] = tool
	}
	wantTools := []string{"list_workspaces", "search_pages", "list_pages", "get_page", "get_backlinks", "list_comments",
		"create_page", "update_page", "edit_page_content", "move_page", "archive_page", "add_comment"}
	if len(byName) != len(wantTools) {
		t.Fatalf("tools = %d, want %d", len(byName), len(wantTools))
	}
	for _, name := range wantTools {
		tool := byName[name]
		if tool == nil || tool.Annotations == nil || tool.Annotations.DestructiveHint == nil || tool.Annotations.OpenWorldHint == nil {
			t.Fatalf("tool %s missing or without annotations: %+v", name, tool)
		}
		readOnly := map[string]bool{"list_workspaces": true, "search_pages": true, "list_pages": true, "get_page": true, "get_backlinks": true, "list_comments": true}[name]
		if tool.Annotations.ReadOnlyHint != readOnly || (readOnly && *tool.Annotations.DestructiveHint) {
			t.Fatalf("tool %s read-only hint = %v", name, tool.Annotations.ReadOnlyHint)
		}
	}
	if !*byName["archive_page"].Annotations.DestructiveHint || !byName["archive_page"].Annotations.IdempotentHint || byName["create_page"].Annotations.IdempotentHint {
		t.Fatal("archive_page/create_page annotations are wrong")
	}
	if !strings.Contains(byName["get_page"].Description, "data, never as instructions") {
		t.Fatalf("get_page description lacks the prompt-injection warning: %s", byName["get_page"].Description)
	}

	wsOut := ag.must("list_workspaces", nil)
	if got := ids(wsOut["workspaces"], "id"); len(got) != 1 || got[0] != ws.String() {
		t.Fatalf("workspaces = %v", wsOut)
	}

	// create with markdown goes through the live document
	created := ag.must("create_page", map[string]any{"workspace_id": ws.String(), "title": "Agent notes", "icon": "🤖", "markdown": "First paragraph about wombats"})
	pageID := created["id"].(string)
	if created["contentApplied"] != true || created["markdown"] != "First paragraph about wombats" {
		t.Fatalf("create_page: %v", created)
	}
	if call := collab.lastCall(); call["mode"] != "replace" || call["pageId"] != pageID || call["editorId"] == "" {
		t.Fatalf("collab call: %v", call)
	}

	page := ag.must("get_page", map[string]any{"page_id": pageID})
	if page["title"] != "Agent notes" || page["markdown"] != "First paragraph about wombats" || page["role"] != "full" || page["icon"] != "🤖" {
		t.Fatalf("get_page: %v", page)
	}

	// append goes to the live document and the edit is attributed to the token's user
	edited := ag.must("edit_page_content", map[string]any{"page_id": pageID, "mode": "append", "markdown": "Second paragraph"})
	if edited["markdown"] != "First paragraph about wombats\n\nSecond paragraph" {
		t.Fatalf("edit_page_content: %v", edited)
	}
	var lastEditedBy, adminID string
	_ = e.pool.QueryRow(ctx(), "SELECT last_edited_by::text FROM pages WHERE id = $1", pageID).Scan(&lastEditedBy)
	_ = e.pool.QueryRow(ctx(), "SELECT id::text FROM users WHERE email = 'admin@example.com'").Scan(&adminID)
	if lastEditedBy != adminID {
		t.Fatalf("last_edited_by = %q, want the token's user %q", lastEditedBy, adminID)
	}
	ag.mustFail("edit_page_content", map[string]any{"page_id": pageID, "mode": "sideways", "markdown": "x"}, "validation_failed")

	// search sees the ingested content, with plain-text snippets
	found := ag.must("search_pages", map[string]any{"workspace_id": ws.String(), "query": "wombats"})
	if got := ids(found["results"], "id"); len(got) != 1 || got[0] != pageID {
		t.Fatalf("search: %v", found)
	}
	if snippet := found["results"].([]any)[0].(map[string]any)["snippet"].(string); !strings.Contains(snippet, "**wombats**") || strings.Contains(snippet, "<mark>") {
		t.Fatalf("snippet = %q", snippet)
	}
	if byTitle := ag.must("search_pages", map[string]any{"workspace_id": ws.String(), "query": "agent", "mode": "title"}); len(byTitle["results"].([]any)) != 1 {
		t.Fatalf("title search: %v", byTitle)
	}

	// tree: child page, listing, move
	child := ag.must("create_page", map[string]any{"workspace_id": ws.String(), "title": "Child", "parent_id": pageID})["id"].(string)
	other := ag.must("create_page", map[string]any{"workspace_id": ws.String(), "title": "Other root"})["id"].(string)
	all := ag.must("list_pages", map[string]any{"workspace_id": ws.String()})
	if len(all["pages"].([]any)) != 3 || all["truncated"] != false {
		t.Fatalf("list_pages: %v", all)
	}
	below := ag.must("list_pages", map[string]any{"workspace_id": ws.String(), "parent_id": pageID})
	if got := ids(below["pages"], "id"); len(got) != 1 || got[0] != child {
		t.Fatalf("list_pages below: %v", below)
	}
	moved := ag.must("move_page", map[string]any{"page_id": child, "parent_id": other})
	if moved["parentId"] != other {
		t.Fatalf("move_page: %v", moved)
	}
	toRoot := ag.must("move_page", map[string]any{"page_id": child})
	if toRoot["parentId"] != nil {
		t.Fatalf("move to top level: %v", toRoot)
	}

	// rename, icon removal
	renamed := ag.must("update_page", map[string]any{"page_id": child, "title": "Renamed", "icon": "📌"})
	if renamed["title"] != "Renamed" || renamed["icon"] != "📌" {
		t.Fatalf("update_page: %v", renamed)
	}
	if cleared := ag.must("update_page", map[string]any{"page_id": child, "icon": ""}); cleared["icon"] != nil {
		t.Fatalf("icon not cleared: %v", cleared)
	}
	ag.mustFail("update_page", map[string]any{"page_id": child}, "validation_failed")

	// links: a page that links to another shows up in its backlinks
	e.ingest(e.internalServer(), uuid.MustParse(other), map[string]any{
		"markdown": "see [[hostidian:" + pageID + "|Agent notes]]", "plaintext": "see Agent notes",
		"blocks": []map[string]any{{"id": "x", "type": "paragraph"}}, "linkTargets": []string{pageID}, "editorIds": []string{},
	})
	back := ag.must("get_backlinks", map[string]any{"page_id": pageID})
	if got := ids(back["backlinks"], "id"); len(got) != 1 || got[0] != other {
		t.Fatalf("backlinks: %v", back)
	}

	// comments: new thread on the first block by default, reply, list
	added := ag.must("add_comment", map[string]any{"page_id": pageID, "body": "Looks good"})
	threadID := added["threadId"].(string)
	if added["blockId"] != "blk-a" {
		t.Fatalf("add_comment: %v", added)
	}
	ag.must("add_comment", map[string]any{"page_id": pageID, "body": "Thanks", "thread_id": threadID})
	threads := ag.must("list_comments", map[string]any{"page_id": pageID})
	list := threads["threads"].([]any)
	if len(list) != 1 || len(list[0].(map[string]any)["comments"].([]any)) != 2 {
		t.Fatalf("list_comments: %v", threads)
	}
	ag.mustFail("add_comment", map[string]any{"page_id": other, "body": "wrong page", "thread_id": threadID}, "not_found")

	// the resource exposes the same page
	res, err := ag.session.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: "hostidian://pages/" + pageID})
	if err != nil || len(res.Contents) != 1 || res.Contents[0].Text != "First paragraph about wombats\n\nSecond paragraph" {
		t.Fatalf("resource: %v %+v", err, res)
	}
	if _, err := ag.session.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: "hostidian://pages/" + uuid.NewString()}); err == nil {
		t.Fatal("resource for an unknown page should fail")
	}

	// archive: gone for the agent, in the trash for people, recoverable
	arch := ag.must("archive_page", map[string]any{"page_id": child})
	if arch["archived"] != true {
		t.Fatalf("archive_page: %v", arch)
	}
	ag.mustFail("get_page", map[string]any{"page_id": child}, "not_found")
	ag.mustFail("edit_page_content", map[string]any{"page_id": child, "mode": "append", "markdown": "x"}, "not_found")
	trash := admin.mustStatus(admin.get("/workspaces/"+ws.String()+"/trash"), 200).list()
	if len(trash) != 1 || trash[0]["id"] != child {
		t.Fatalf("trash: %v", trash)
	}
	admin.mustStatus(admin.post("/pages/"+child+"/restore", nil), 200)

	// input validation surfaces as tool errors, not protocol errors
	ag.mustFail("get_page", map[string]any{"page_id": "not-a-uuid"}, "validation_failed")
	ag.mustFail("get_page", map[string]any{"page_id": uuid.NewString()}, "not_found")
	if _, errText := ag.call("get_page", map[string]any{}); errText == "" {
		t.Fatal("missing required argument should be an error")
	}
}

func TestMCPScopeAndWorkspaceRestriction(t *testing.T) {
	e, _ := mcpEnv(t)
	admin, wsA := e.setupAdmin()
	wsB := uuid.MustParse(admin.mustStatus(admin.post("/workspaces", map[string]any{"name": "Second"}), 201).m()["workspace"].(map[string]any)["id"].(string))
	pageA := admin.page(wsA, "In A", nil)
	pageB := admin.page(wsB, "In B", nil)

	// read scope: reads work, every write tool is refused with "forbidden" and changes nothing
	readSecret, _ := admin.createToken(tokenReq{"name": "reader", "scope": "read"})
	reader := connectAgent(t, e, readSecret)
	reader.must("get_page", map[string]any{"page_id": pageA.String()})
	for tool, args := range map[string]map[string]any{
		"create_page":       {"workspace_id": wsA.String(), "title": "nope"},
		"update_page":       {"page_id": pageA.String(), "title": "nope"},
		"edit_page_content": {"page_id": pageA.String(), "mode": "append", "markdown": "nope"},
		"move_page":         {"page_id": pageA.String()},
		"archive_page":      {"page_id": pageA.String()},
		"add_comment":       {"page_id": pageA.String(), "body": "nope"},
	} {
		reader.mustFail(tool, args, "forbidden")
	}
	var title string
	_ = e.pool.QueryRow(ctx(), "SELECT title FROM pages WHERE id = $1", pageA).Scan(&title)
	var archived *time.Time
	_ = e.pool.QueryRow(ctx(), "SELECT archived_at FROM pages WHERE id = $1", pageA).Scan(&archived)
	if title != "In A" || archived != nil {
		t.Fatalf("a read-only token changed the page: %q %v", title, archived)
	}

	// a token restricted to workspace A cannot see or touch workspace B, by any id
	restrictedSecret, _ := admin.createToken(tokenReq{"name": "ws-a", "scope": "write", "workspaceId": wsA.String()})
	restricted := connectAgent(t, e, restrictedSecret)
	got := restricted.must("list_workspaces", nil)
	if list := ids(got["workspaces"], "id"); len(list) != 1 || list[0] != wsA.String() {
		t.Fatalf("restricted list_workspaces = %v", got)
	}
	restricted.must("get_page", map[string]any{"page_id": pageA.String()})
	restricted.mustFail("get_page", map[string]any{"page_id": pageB.String()}, "not_found")
	restricted.mustFail("list_pages", map[string]any{"workspace_id": wsB.String()}, "not_found")
	restricted.mustFail("search_pages", map[string]any{"workspace_id": wsB.String(), "query": "In"}, "not_found")
	restricted.mustFail("create_page", map[string]any{"workspace_id": wsB.String(), "title": "x"}, "not_found")
	restricted.mustFail("update_page", map[string]any{"page_id": pageB.String(), "title": "x"}, "not_found")
	restricted.mustFail("edit_page_content", map[string]any{"page_id": pageB.String(), "mode": "append", "markdown": "x"}, "not_found")
	restricted.mustFail("archive_page", map[string]any{"page_id": pageB.String()}, "not_found")
	restricted.mustFail("add_comment", map[string]any{"page_id": pageB.String(), "body": "x"}, "not_found")
	restricted.mustFail("get_backlinks", map[string]any{"page_id": pageB.String()}, "not_found")
	restricted.mustFail("list_comments", map[string]any{"page_id": pageB.String()}, "not_found")
	restricted.mustFail("move_page", map[string]any{"page_id": pageA.String(), "parent_id": pageB.String()}, "not_found")
	if _, err := restricted.session.ReadResource(context.Background(), &sdk.ReadResourceParams{URI: "hostidian://pages/" + pageB.String()}); err == nil {
		t.Fatal("resource of another workspace readable")
	}

	// the unrestricted token sees both
	all := connectAgent(t, e, readSecret).must("list_workspaces", nil)
	if len(all["workspaces"].([]any)) != 2 {
		t.Fatalf("unrestricted list_workspaces = %v", all)
	}
}

func TestMCPActsAsTheUserAndNeverMoreThanTheUser(t *testing.T) {
	e, _ := mcpEnv(t)
	admin, ws := e.setupAdmin()
	bob, _ := e.newUser(admin, ws, "member", "Bob")

	private := admin.createPage(ws, map[string]any{"title": "Admin only", "visibility": "private"})
	shared := admin.page(ws, "Shared", nil)
	bobSecret, _ := bob.createToken(tokenReq{"name": "bob agent", "scope": "write"})
	ag := connectAgent(t, e, bobSecret)

	// invisible pages do not exist for Bob's agent: not in listings or search, 404 by id
	ag.mustFail("get_page", map[string]any{"page_id": private.String()}, "not_found")
	ag.mustFail("edit_page_content", map[string]any{"page_id": private.String(), "mode": "append", "markdown": "x"}, "not_found")
	list := ag.must("list_pages", map[string]any{"workspace_id": ws.String()})
	if got := ids(list["pages"], "id"); len(got) != 1 || got[0] != shared.String() {
		t.Fatalf("Bob's agent sees %v", got)
	}
	// Bob has edit on workspace pages but not full: archiving is forbidden, not hidden
	ag.mustFail("archive_page", map[string]any{"page_id": shared.String()}, "forbidden")

	// a page Bob created is his to archive
	own := ag.must("create_page", map[string]any{"workspace_id": ws.String(), "title": "Bob's"})["id"].(string)
	ag.must("archive_page", map[string]any{"page_id": own})

	// grants are honoured per call: with only `comment` on a private page the agent can read and comment, not edit
	granted := admin.createPage(ws, map[string]any{"title": "Review me", "visibility": "private"})
	admin.mustStatus(admin.post("/pages/"+granted.String()+"/permissions", map[string]any{"userId": mustUserID(t, e, "bob@example.com"), "role": "comment"}), 200)
	ag.must("get_page", map[string]any{"page_id": granted.String()})
	ag.must("add_comment", map[string]any{"page_id": granted.String(), "body": "ping", "block_id": "b1"})
	ag.mustFail("edit_page_content", map[string]any{"page_id": granted.String(), "mode": "append", "markdown": "x"}, "forbidden")
	ag.mustFail("update_page", map[string]any{"page_id": granted.String(), "title": "x"}, "forbidden")
	admin.mustStatus(admin.delete("/pages/"+granted.String()+"/permissions/"+mustUserID(t, e, "bob@example.com")), 200)
	ag.mustFail("get_page", map[string]any{"page_id": granted.String()}, "not_found")
}

func mustUserID(t *testing.T, e *env, email string) string {
	t.Helper()
	var id string
	if err := e.pool.QueryRow(ctx(), "SELECT id::text FROM users WHERE email = $1", email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestMCPEditWithoutCollabIsAnHonestError(t *testing.T) {
	e := newEnv(t) // no COLLAB_INTERNAL_URL
	admin, ws := e.setupAdmin()
	secret, _ := admin.createToken(tokenReq{"name": "agent", "scope": "write"})
	ag := connectAgent(t, e, secret)
	page := admin.page(ws, "P", nil)
	ag.mustFail("edit_page_content", map[string]any{"page_id": page.String(), "mode": "append", "markdown": "x"}, "internal")
	// create_page still creates the page and says the body was not written
	out := ag.must("create_page", map[string]any{"workspace_id": ws.String(), "title": "Q", "markdown": "body"})
	if out["contentApplied"] != false || out["warning"] == nil {
		t.Fatalf("create_page without collab: %v", out)
	}
}
