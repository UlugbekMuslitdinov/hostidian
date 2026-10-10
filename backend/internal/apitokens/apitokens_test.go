package apitokens

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestGenerateFormat(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		tok, err := generate()
		if err != nil {
			t.Fatal(err)
		}
		// hst_ + 32 random bytes as unpadded base64url (43 characters)
		if !strings.HasPrefix(tok, "hst_") || len(tok) != 47 || strings.ContainsAny(tok[4:], "=+/") || seen[tok] {
			t.Fatalf("bad or repeated token %q", tok)
		}
		seen[tok] = true
	}
}

func TestAllowIsPerTokenAndRefills(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	s := NewService(Options{Log: slog.Default(), Now: func() time.Time { return now }})
	a, b := uuid.New(), uuid.New()
	for i := 0; i < 120; i++ {
		if !s.Allow(a) {
			t.Fatalf("request %d of the burst refused", i+1)
		}
	}
	if s.Allow(a) {
		t.Fatal("121st request in the same instant was allowed")
	}
	if !s.Allow(b) {
		t.Fatal("another token must have its own budget")
	}
	now = now.Add(30 * time.Second) // 120/min => 60 requests refilled
	allowed := 0
	for s.Allow(a) && allowed < 100 {
		allowed++
	}
	if allowed < 59 || allowed > 61 {
		t.Fatalf("refilled %d requests after 30s, want about 60", allowed)
	}
}

func TestVerifyRejectsMalformedWithoutTouchingTheDatabase(t *testing.T) {
	s := NewService(Options{Log: slog.Default()}) // nil queries: any lookup would panic
	for _, secret := range []string{"", "abc", "Bearer hst_x", "hst_" + strings.Repeat("a", 200)} {
		if _, err := s.Verify(t.Context(), secret); err != ErrInvalidToken {
			t.Fatalf("Verify(%q) = %v", secret, err)
		}
	}
}

func TestMCPURL(t *testing.T) {
	if got := NewService(Options{PublicURL: "https://notes.example.com/"}).MCPURL(); got != "https://notes.example.com/api/mcp" {
		t.Fatalf("MCPURL = %q", got)
	}
}
