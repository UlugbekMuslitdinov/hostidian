package httpapi_test

import (
	"archive/zip"
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"
)

// An Obsidian-style vault exercises the three importer pitfalls: links to pages imported later in the
// zip, ![[embeds]], and folders that have no Folder/Folder.md page of their own.
func TestImportResolvesForwardLinksEmbedsAndPureFolders(t *testing.T) {
	e := newEnv(t, func(o *envOpts) {
		o.configure = func(m map[string]string) { m["DATA_DIR"] = t.TempDir() }
	})
	c, ws := e.setupAdmin()

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	add := func(name string, data []byte) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	// Index.md sorts before Projects/ and Notes.md, so every link in it points at a page created later.
	add("Vault/Index.md", []byte("Go to [[Projects]], see ![[logo.png|300]] and ![[Notes]]."))
	add("Vault/Projects/Plan.md", []byte("Back to [[Index]]."))
	add("Vault/Notes.md", []byte("notes"))
	add("Vault/logo.png", png)
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	body, ct := multipartForm(t, "file", "vault.zip", zbuf.Bytes(), nil)
	job := c.mustStatus(c.request("POST", "/workspaces/"+ws.String()+"/import", body, func(req *http.Request) {
		req.Header.Set("Content-Type", ct)
	}), 202).m()
	for i := 0; i < 200; i++ {
		got := c.mustStatus(c.get("/import-jobs/"+job["id"].(string)), 200).m()
		if st := got["status"].(string); st == "done" {
			break
		} else if st == "failed" {
			t.Fatalf("import failed: %v", got)
		}
		time.Sleep(25 * time.Millisecond)
	}

	ids := map[string]string{}
	for _, p := range c.mustStatus(c.get("/workspaces/"+ws.String()+"/pages"), 200).list() {
		title := p["title"].(string)
		if title == "Untitled" {
			t.Fatalf("a page was imported as Untitled: %v", p)
		}
		ids[title] = p["id"].(string)
	}
	for _, want := range []string{"Vault", "Projects", "Index", "Plan", "Notes"} {
		if ids[want] == "" {
			t.Fatalf("page %q missing after import; have %v", want, ids)
		}
	}

	md := c.mustStatus(c.get("/pages/"+ids["Index"]+"/content"), 200).m()["markdown"].(string)
	if !strings.Contains(md, "[[hostidian:"+ids["Projects"]+"|Projects]]") {
		t.Errorf("forward link to Projects not resolved: %q", md)
	}
	if !strings.Contains(md, "[[hostidian:"+ids["Notes"]+"|Notes]]") {
		t.Errorf("![[Notes]] embed not turned into a page link: %q", md)
	}
	if !strings.Contains(md, "![logo.png](/api/files/") {
		t.Errorf("![[logo.png|300]] embed not stored as an attachment: %q", md)
	}
	if strings.Contains(md, "000000000000") || strings.Contains(md, "![[") {
		t.Errorf("unresolved leftovers in %q", md)
	}

	// page_links must hold the forward link too, so backlinks and the graph see it.
	back := c.mustStatus(c.get("/pages/"+ids["Projects"]+"/backlinks"), 200).list()
	found := false
	for _, b := range back {
		if b["id"] == ids["Index"] {
			found = true
		}
	}
	if !found {
		t.Errorf("Index missing from Projects' backlinks: %v", back)
	}
}
