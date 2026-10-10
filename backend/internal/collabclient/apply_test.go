package collabclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestApplyMarkdown(t *testing.T) {
	var got map[string]string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/apply-markdown" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("unexpected request %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		w.WriteHeader(status)
		switch status {
		case http.StatusOK:
			_, _ = w.Write([]byte(`{"markdown":"# Result"}`))
		default:
			_, _ = w.Write([]byte(`{"error":{"code":"x","message":"nope"}}`))
		}
	}))
	defer srv.Close()
	c := New(srv.URL+"/", "secret", slog.Default())
	req := ApplyRequest{PageID: uuid.New(), Markdown: "hi", Mode: ApplyAppend, EditorID: uuid.New()}

	md, err := c.ApplyMarkdown(context.Background(), req)
	if err != nil || md != "# Result" {
		t.Fatalf("ApplyMarkdown = %q, %v", md, err)
	}
	if got["pageId"] != req.PageID.String() || got["mode"] != "append" || got["editorId"] != req.EditorID.String() || got["markdown"] != "hi" {
		t.Fatalf("request body: %v", got)
	}

	status = http.StatusNotFound
	if _, err := c.ApplyMarkdown(context.Background(), req); !errors.Is(err, ErrPageNotFound) {
		t.Fatalf("404 -> %v", err)
	}
	status = http.StatusUnprocessableEntity
	if _, err := c.ApplyMarkdown(context.Background(), req); !errors.Is(err, ErrInvalidMarkdown) {
		t.Fatalf("422 -> %v", err)
	}
	status = http.StatusInternalServerError
	if _, err := c.ApplyMarkdown(context.Background(), req); err == nil || errors.Is(err, ErrPageNotFound) {
		t.Fatalf("500 -> %v", err)
	}

	req.Mode = "bogus"
	if _, err := c.ApplyMarkdown(context.Background(), req); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

func TestApplyMarkdownNotConfigured(t *testing.T) {
	req := ApplyRequest{PageID: uuid.New(), Mode: ApplyReplace}
	for name, a := range map[string]Applier{"empty url": New("", "x", slog.Default()), "noop": Noop{}} {
		if _, err := a.ApplyMarkdown(context.Background(), req); !errors.Is(err, ErrNotConfigured) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}
