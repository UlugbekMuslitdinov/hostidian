package httpapi_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const internalTokenForTests = "internal-token-for-tests-0123456789"

// internalServer mounts the service-to-service router on its own listener.
func (e *env) internalServer() *httptest.Server {
	e.t.Helper()
	ts := httptest.NewServer(e.server.InternalHandler())
	e.t.Cleanup(ts.Close)
	return ts
}

// ingest pushes extracted content for a page (collab → api).
func (e *env) ingest(ts *httptest.Server, pageID uuid.UUID, body map[string]any) {
	e.t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/internal/pages/"+pageID.String()+"/content", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+internalTokenForTests)
	res, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		data, _ := io.ReadAll(res.Body)
		e.t.Fatalf("ingest status = %d: %s", res.StatusCode, data)
	}
}

// multipart uploads build a form body and its content type.
func multipartForm(t *testing.T, field, filename string, data []byte, extra map[string]string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatal(err)
	}
	for k, v := range extra {
		_ = w.WriteField(k, v)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), w.FormDataContentType()
}

func TestSearchBacklinksGraph(t *testing.T) {
	e := newEnv(t)
	internal := e.internalServer()
	c, ws := e.setupAdmin()

	a := c.page(ws, "Alpha", nil)
	b := c.page(ws, "Beta", nil)
	c.page(ws, "Gamma", nil)

	e.ingest(internal, a, map[string]any{
		"markdown":    "hello world linking to [[hostidian:" + b.String() + "|Beta]]",
		"plaintext":   "hello world linking to Beta",
		"blocks":      []map[string]any{{"id": "blk1", "type": "paragraph"}},
		"linkTargets": []string{b.String()},
		"editorIds":   []string{},
	})

	// full-text search finds the body text
	res := c.mustStatus(c.get("/workspaces/"+ws.String()+"/search?q=hello"), 200)
	results := res.list()
	if len(results) != 1 {
		t.Fatalf("search results = %d, want 1: %s", len(results), res.body)
	}
	if results[0]["page"].(map[string]any)["id"].(string) != a.String() {
		t.Fatalf("search hit wrong page: %s", res.body)
	}
	if results[0]["snippet"] == nil {
		t.Fatalf("expected a snippet: %s", res.body)
	}

	// title mode quick-switch
	res = c.mustStatus(c.get("/workspaces/"+ws.String()+"/search?q=bet&mode=title"), 200)
	if len(res.list()) == 0 {
		t.Fatalf("title search found nothing")
	}

	// backlinks of Beta include Alpha
	res = c.mustStatus(c.get("/pages/"+b.String()+"/backlinks"), 200)
	links := res.list()
	if len(links) != 1 || links[0]["id"].(string) != a.String() {
		t.Fatalf("backlinks = %s", res.body)
	}

	// graph has all nodes and the Alpha->Beta edge
	res = c.mustStatus(c.get("/workspaces/"+ws.String()+"/graph"), 200)
	graph := res.m()
	if len(graph["nodes"].([]any)) != 3 {
		t.Fatalf("graph nodes = %s", res.body)
	}
	edges := graph["edges"].([]any)
	if len(edges) != 1 {
		t.Fatalf("graph edges = %s", res.body)
	}
	edge := edges[0].(map[string]any)
	if edge["source"].(string) != a.String() || edge["target"].(string) != b.String() {
		t.Fatalf("edge = %s", res.body)
	}
}

func TestCommentsLifecycle(t *testing.T) {
	e := newEnv(t)
	c, ws := e.setupAdmin()
	pid := c.page(ws, "Doc", nil)

	created := c.mustStatus(c.post("/pages/"+pid.String()+"/comments", map[string]any{
		"blockId": "block-1", "quote": "snippet", "body": "first comment",
	}), 201).m()
	threadID := created["id"].(string)
	if len(created["comments"].([]any)) != 1 {
		t.Fatalf("thread comments = %s", created)
	}

	// reply
	c.mustStatus(c.post("/comment-threads/"+threadID+"/comments", map[string]any{"body": "a reply"}), 201)

	// list shows the thread with two comments
	list := c.mustStatus(c.get("/pages/"+pid.String()+"/comments"), 200).list()
	if len(list) != 1 || len(list[0]["comments"].([]any)) != 2 {
		t.Fatalf("threads = %v", list)
	}

	// resolve then reopen
	c.mustStatus(c.post("/comment-threads/"+threadID+"/resolve", nil), 200)
	resolved := c.mustStatus(c.get("/pages/"+pid.String()+"/comments"), 200).list()
	if len(resolved) != 0 {
		t.Fatalf("resolved thread should be hidden by default: %v", resolved)
	}
	withResolved := c.mustStatus(c.get("/pages/"+pid.String()+"/comments?includeResolved=true"), 200).list()
	if len(withResolved) != 1 || withResolved[0]["resolvedAt"] == nil {
		t.Fatalf("expected resolved thread: %v", withResolved)
	}
	c.mustStatus(c.post("/comment-threads/"+threadID+"/reopen", nil), 200)

	// edit and delete a comment
	commentID := withResolved[0]["comments"].([]any)[0].(map[string]any)["id"].(string)
	c.mustStatus(c.patch("/comments/"+commentID, map[string]any{"body": "edited"}), 200)
	c.mustStatus(c.delete("/comments/"+commentID), 204)

	// deleting every comment removes the thread
	otherID := withResolved[0]["comments"].([]any)[1].(map[string]any)["id"].(string)
	c.mustStatus(c.delete("/comments/"+otherID), 204)
	final := c.mustStatus(c.get("/pages/"+pid.String()+"/comments?includeResolved=true"), 200).list()
	if len(final) != 0 {
		t.Fatalf("thread should be pruned: %v", final)
	}
}

func TestSharesAndPublicPage(t *testing.T) {
	e := newEnv(t)
	internal := e.internalServer()
	c, ws := e.setupAdmin()
	root := c.page(ws, "Public Root", nil)
	child := c.page(ws, "Child", &root)

	e.ingest(internal, root, map[string]any{
		"markdown": "public body", "plaintext": "public body",
		"blocks": []map[string]any{{"id": "b1", "type": "paragraph"}}, "linkTargets": []string{},
	})

	link := c.mustStatus(c.post("/pages/"+root.String()+"/shares", map[string]any{"includeSubpages": true}), 201).m()
	token := link["token"].(string)
	if !strings.HasSuffix(link["url"].(string), "/s/"+token) {
		t.Fatalf("share url = %s", link["url"])
	}

	anon := e.client()
	pub := anon.mustStatus(anon.get("/public/"+token+"/page"), 200).m()
	if pub["rootPageId"].(string) != root.String() {
		t.Fatalf("public root = %s", pub)
	}
	if len(pub["blocks"].([]any)) != 1 {
		t.Fatalf("public blocks = %s", pub)
	}
	sub := anon.mustStatus(anon.get("/public/"+token+"/pages/"+child.String()), 200).m()
	if sub["page"].(map[string]any)["id"].(string) != child.String() {
		t.Fatalf("public subpage = %s", sub)
	}

	// listing requires full access
	c.mustStatus(c.get("/pages/"+root.String()+"/shares"), 200)

	// revoke → 404
	shareID := link["id"].(string)
	c.mustStatus(c.delete("/shares/"+shareID), 204)
	anon.mustStatus(anon.get("/public/"+token+"/page"), 404)
}

func TestFileUploadDownloadAndPublic(t *testing.T) {
	e := newEnv(t, func(o *envOpts) {
		o.configure = func(m map[string]string) { m["DATA_DIR"] = t.TempDir() }
	})
	c, ws := e.setupAdmin()
	pid := c.page(ws, "With File", nil)

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	body, ct := multipartForm(t, "file", "picture.png", png, map[string]string{"pageId": pid.String()})
	r := c.request("POST", "/workspaces/"+ws.String()+"/files", body, func(req *http.Request) {
		req.Header.Set("Content-Type", ct)
	})
	att := c.mustStatus(r, 201).m()
	fileID := att["id"].(string)
	if att["contentType"].(string) != "image/png" {
		t.Fatalf("content type = %s", att["contentType"])
	}
	if att["url"].(string) != "/api/files/"+fileID {
		t.Fatalf("url = %s", att["url"])
	}

	dl := c.mustStatus(c.get("/files/"+fileID), 200)
	if dl.header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing nosniff")
	}
	if ct := dl.header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("served content type = %s", ct)
	}
	if !strings.HasPrefix(dl.header.Get("Content-Disposition"), "inline") {
		t.Fatalf("disposition = %s", dl.header.Get("Content-Disposition"))
	}
	if !bytes.Equal(dl.body, png) {
		t.Fatalf("served bytes differ")
	}
}

func TestExportImportRoundTrip(t *testing.T) {
	e := newEnv(t, func(o *envOpts) {
		o.configure = func(m map[string]string) { m["DATA_DIR"] = t.TempDir() }
	})
	internal := e.internalServer()
	c, ws := e.setupAdmin()

	a := c.page(ws, "Alpha", nil)
	b := c.page(ws, "Beta", &a)
	e.ingest(internal, a, map[string]any{
		"markdown":  "# Alpha\n\nlinks to [[hostidian:" + b.String() + "|Beta]]",
		"plaintext": "Alpha links to Beta", "blocks": []map[string]any{{"id": "x", "type": "paragraph"}},
		"linkTargets": []string{b.String()},
	})
	e.ingest(internal, b, map[string]any{
		"markdown": "child body referencing [[Alpha]]", "plaintext": "child body referencing Alpha",
		"blocks": []map[string]any{{"id": "y", "type": "paragraph"}}, "linkTargets": []string{a.String()},
	})

	exp := c.mustStatus(c.get("/pages/"+a.String()+"/export"), 200)
	if exp.header.Get("Content-Type") != "application/zip" {
		t.Fatalf("export content type = %s", exp.header.Get("Content-Type"))
	}
	zr, err := zip.NewReader(bytes.NewReader(exp.body), int64(len(exp.body)))
	if err != nil {
		t.Fatalf("export is not a zip: %v", err)
	}
	var mdFiles int
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, ".md") {
			mdFiles++
			rc, _ := f.Open()
			data, _ := io.ReadAll(rc)
			rc.Close()
			if !strings.Contains(string(data), "---") {
				t.Fatalf("missing frontmatter in %s", f.Name)
			}
			if strings.Contains(string(data), "hostidian:") {
				t.Fatalf("stored link leaked into export %s: %s", f.Name, data)
			}
		}
	}
	if mdFiles != 2 {
		t.Fatalf("exported %d markdown files, want 2", mdFiles)
	}

	// import the same zip back as a new top-level tree
	importBody, ct := multipartForm(t, "file", "export.zip", exp.body, nil)
	ir := c.request("POST", "/workspaces/"+ws.String()+"/import", importBody, func(req *http.Request) {
		req.Header.Set("Content-Type", ct)
	})
	job := c.mustStatus(ir, 202).m()
	jobID := job["id"].(string)

	var status string
	for i := 0; i < 100; i++ {
		got := c.mustStatus(c.get("/import-jobs/"+jobID), 200).m()
		status = got["status"].(string)
		if status == "done" || status == "failed" {
			if status == "failed" {
				t.Fatalf("import failed: %s", got)
			}
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != "done" {
		t.Fatalf("import did not finish, status = %s", status)
	}

	// the imported subtree adds pages (Alpha + Beta)
	list := c.mustStatus(c.get("/workspaces/"+ws.String()+"/pages"), 200).list()
	if len(list) != 4 {
		t.Fatalf("page count after import = %d, want 4 (%v)", len(list), list)
	}
}
