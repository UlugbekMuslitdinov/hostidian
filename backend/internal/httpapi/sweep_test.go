package httpapi_test

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSweepFilesRemovesOnlyUnreferenced(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(o *envOpts) {
		o.configure = func(m map[string]string) { m["DATA_DIR"] = dir }
	})
	c, ws := e.setupAdmin()
	pid := c.page(ws, "Files", nil)

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	upload := func() string {
		body, ct := multipartForm(t, "file", "p.png", png, map[string]string{"pageId": pid.String()})
		r := c.request("POST", "/workspaces/"+ws.String()+"/files", body, func(req *http.Request) {
			req.Header.Set("Content-Type", ct)
		})
		return c.mustStatus(r, 201).m()["id"].(string)
	}
	keep, drop := upload(), upload()

	// Only `keep` is referenced by the page's extracted content.
	ts := e.internalServer()
	e.ingest(ts, pid, map[string]any{
		"markdown": "![x](/api/files/" + keep + ")", "plaintext": "x",
		"blocks": []any{}, "linkTargets": []string{},
	})

	// A stray file on disk with no attachment row.
	orphan := uuid.New()
	orphanPath := filepath.Join(dir, "files", "zz", orphan.String())
	if err := os.MkdirAll(filepath.Dir(orphanPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphanPath, []byte("stray"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Young files are protected by the age guard.
	if n, err := e.server.SweepFiles(context.Background(), time.Hour); err != nil || n != 0 {
		t.Fatalf("sweep with age guard = %d, %v; want 0, nil", n, err)
	}

	n, err := e.server.SweepFiles(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("removed = %d, want 2 (unreferenced upload + orphan file)", n)
	}
	c.mustStatus(c.get("/files/"+keep), 200)
	c.mustStatus(c.get("/files/"+drop), 404)
	if _, err := os.Stat(orphanPath); !os.IsNotExist(err) {
		t.Fatalf("orphan file still on disk: %v", err)
	}
}
