package mcp

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
)

func TestCapTextCutsOnRuneBoundaries(t *testing.T) {
	s := strings.Repeat("é", 10) // 2 bytes each
	for max := 0; max <= 21; max++ {
		out, cut := capText(s, max)
		if len(out) > max || (len(s) > max) != cut || !strings.HasPrefix(s, out) {
			t.Fatalf("max=%d: %q cut=%v", max, out, cut)
		}
		if strings.ContainsRune(out, '�') {
			t.Fatalf("max=%d split a rune: %q", max, out)
		}
	}
}

func TestSnippetTextIsPlainText(t *testing.T) {
	got := snippetText("a &lt;b&gt; <mark>wombat</mark> &amp; co")
	if got != "a <b> **wombat** & co" {
		t.Fatalf("snippetText = %q", got)
	}
}

func TestDescribeErrors(t *testing.T) {
	cases := []struct {
		err      error
		code     string
		contains string
	}{
		{apperr.NotFound("Page not found."), "not_found", "Page not found."},
		{apperr.FieldError("title", "Must be at most 500 characters."), "validation_failed", "title: Must be"},
		{apperr.Internal(errors.New("secret db detail")), "internal", "Something went wrong."},
		{fmt.Errorf("wrap: %w", collabclient.ErrNotConfigured), "internal", "not configured"},
		{collabclient.ErrPageNotFound, "not_found", "Page not found."},
		{fmt.Errorf("%w: bad", collabclient.ErrInvalidMarkdown), "validation_failed", "Markdown"},
		{errors.New("pq: connection refused to 10.0.0.5"), "internal", "try again"},
	}
	for _, c := range cases {
		code, msg := describe(c.err)
		if code != c.code || !strings.Contains(msg, c.contains) || strings.Contains(msg, "secret") || strings.Contains(msg, "10.0.0.5") {
			t.Errorf("describe(%v) = %q, %q", c.err, code, msg)
		}
	}
}

func TestUUIDArgs(t *testing.T) {
	if _, err := uuidArg("page_id", "nope"); err == nil {
		t.Fatal("garbage accepted")
	}
	if _, err := uuidArg("page_id", "00000000-0000-0000-0000-000000000000"); err == nil {
		t.Fatal("nil uuid accepted")
	}
	if id, err := optionalUUIDArg("parent_id", "  "); err != nil || id != nil {
		t.Fatalf("blank = %v, %v", id, err)
	}
}
