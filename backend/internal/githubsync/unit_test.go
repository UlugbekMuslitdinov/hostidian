package githubsync

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDecide(t *testing.T) {
	t0 := time.Now()
	base := Base{Title: "T", State: "open", LocalBodyHash: "L", RemoteBodyHash: "R"}
	same := Side{Title: "T", BodyHash: "L", UpdatedAt: t0}
	remoteSame := Side{Title: "T", BodyHash: "R", UpdatedAt: t0}

	cases := []struct {
		name          string
		local, remote Side
		state         string
		want          Plan
	}{
		{"nothing changed", same, remoteSame, "open", Plan{}},
		{"local title", Side{Title: "X", BodyHash: "L", UpdatedAt: t0}, remoteSame, "open", Plan{Title: Push}},
		{"remote title", same, Side{Title: "X", BodyHash: "R", UpdatedAt: t0}, "open", Plan{Title: Pull}},
		{"local body", Side{Title: "T", BodyHash: "L2", UpdatedAt: t0}, remoteSame, "open", Plan{Body: Push}},
		{"remote body", same, Side{Title: "T", BodyHash: "R2", UpdatedAt: t0}, "open", Plan{Body: Pull}},
		{"remote state", same, remoteSame, "closed", Plan{State: Pull}},
		{"both changed to the same title", Side{Title: "X", BodyHash: "L", UpdatedAt: t0}, Side{Title: "X", BodyHash: "R", UpdatedAt: t0}, "open", Plan{}},
		{"both changed body to the same text", Side{Title: "T", BodyHash: "Z", UpdatedAt: t0}, Side{Title: "T", BodyHash: "Z", UpdatedAt: t0}, "open", Plan{}},
		{"different fields", Side{Title: "X", BodyHash: "L", UpdatedAt: t0}, Side{Title: "T", BodyHash: "R2", UpdatedAt: t0}, "open", Plan{Title: Push, Body: Pull}},
		{"conflict, page newer", Side{Title: "A", BodyHash: "L", UpdatedAt: t0.Add(time.Minute)}, Side{Title: "B", BodyHash: "R", UpdatedAt: t0}, "open", Plan{Title: Push}},
		{"conflict, issue newer", Side{Title: "A", BodyHash: "L", UpdatedAt: t0}, Side{Title: "B", BodyHash: "R", UpdatedAt: t0.Add(time.Minute)}, "open", Plan{Title: Pull}},
		{"conflict tie goes to GitHub", Side{Title: "A", BodyHash: "L", UpdatedAt: t0}, Side{Title: "B", BodyHash: "R", UpdatedAt: t0}, "open", Plan{Title: Pull}},
	}
	for _, c := range cases {
		if got := Decide(base, c.local, c.remote, c.state); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestToGitHubRewritesHostidianSyntax(t *testing.T) {
	linked, other := uuid.New(), uuid.New()
	c := Converter{PublicURL: "https://notes.example.com", WorkspaceSlug: "acme", Issues: map[uuid.UUID]int32{linked: 12}}
	in := "See [[hostidian:" + linked.String() + "|Login bug]] and [[hostidian:" + other.String() + `|Roadmap \] 2026]].` + "\r\n" +
		"![shot](/api/files/abc)"
	got := c.ToGitHub(in)
	for _, want := range []string{
		"See #12 and",
		"[Roadmap \\] 2026](https://notes.example.com/w/acme/p/" + other.String() + ")",
		"![shot](https://notes.example.com/api/files/abc)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("ToGitHub = %q, missing %q", got, want)
		}
	}
	if strings.Contains(got, "hostidian:") || strings.Contains(got, "\r") {
		t.Errorf("hostidian syntax or CR left in %q", got)
	}
}

func TestMarkersRoundTripAndAreInvisibleToHashes(t *testing.T) {
	id := uuid.New()
	body := "hello\r\nworld\n\n" + PageMarker(id)
	clean, got, ok := StripPageMarker(body)
	if !ok || got != id || clean != "hello\nworld" {
		t.Fatalf("StripPageMarker = %q, %v, %v", clean, got, ok)
	}
	if HashBody("a\r\nb  \n") != HashBody("a\nb") {
		t.Error("hash depends on line endings or trailing space")
	}
	cid := uuid.New()
	out := FormatOutgoingComment("Fixed it", "Jane <b>Doe</b>\nSmith", cid)
	if !strings.Contains(out, "via Hostidian, by Jane bDoe/b Smith") || strings.Contains(out, "<b>") {
		t.Errorf("attribution not sanitised: %q", out)
	}
	if parsed, ok := ParseCommentMarker(out); !ok || parsed != cid {
		t.Errorf("marker lost: %v %v", parsed, ok)
	}
}

func TestVault(t *testing.T) {
	v, err := NewVault("secret-one")
	if err != nil {
		t.Fatal(err)
	}
	a, _ := v.Seal([]byte("ghp_token"))
	b, _ := v.Seal([]byte("ghp_token"))
	if string(a) == string(b) {
		t.Error("two seals of the same value are identical (nonce reuse)")
	}
	if strings.Contains(string(a), "ghp_token") {
		t.Error("ciphertext contains the plaintext")
	}
	if got, err := v.Open(a); err != nil || string(got) != "ghp_token" {
		t.Fatalf("Open = %q, %v", got, err)
	}
	a[len(a)-1] ^= 1
	if _, err := v.Open(a); err == nil {
		t.Error("tampered ciphertext was accepted")
	}
	other, _ := NewVault("secret-two")
	good, _ := v.Seal([]byte("x"))
	if _, err := other.Open(good); err == nil {
		t.Error("opened with a different APP_SECRET")
	}
	if _, err := v.Open([]byte("short")); err == nil {
		t.Error("short blob accepted")
	}
	if _, err := NewVault(""); err == nil {
		t.Error("empty APP_SECRET accepted")
	}
}

func TestParseRepository(t *testing.T) {
	ok := map[string][2]string{
		"acme/site":                          {"acme", "site"},
		" acme/site.js ":                     {"acme", "site.js"},
		"https://github.com/acme/site":       {"acme", "site"},
		"https://github.com/acme/site.git":   {"acme", "site"},
		"http://github.com/Acme-Co/my_repo/": {"Acme-Co", "my_repo"},
	}
	for in, want := range ok {
		if o, r, good := ParseRepository(in); !good || o != want[0] || r != want[1] {
			t.Errorf("ParseRepository(%q) = %q %q %v", in, o, r, good)
		}
	}
	for _, in := range []string{"", "acme", "acme/", "/site", "acme/site/extra", "acme/..", "../site", "acme/si te", "acme/site?x=1", "https://evil.example/acme/site", "acme/site#frag"} {
		if o, r, good := ParseRepository(in); good {
			t.Errorf("ParseRepository(%q) accepted as %q/%q", in, o, r)
		}
	}
}

func TestClientReportsRateLimitsAndAuthErrors(t *testing.T) {
	reset := time.Now().Add(90 * time.Second).Unix()
	cases := []struct {
		name    string
		header  map[string]string
		status  int
		auth    bool
		limited bool
	}{
		{"bad token", nil, 401, true, false},
		{"forbidden", nil, 403, true, false},
		{"primary rate limit", map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": strconv.FormatInt(reset, 10)}, 403, false, true},
		{"secondary rate limit", map[string]string{"Retry-After": "30"}, 403, false, true},
		{"429", nil, 429, false, true},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("Authorization"); got != "Bearer tok" {
				t.Errorf("%s: Authorization = %q", c.name, got)
			}
			for k, v := range c.header {
				w.Header().Set(k, v)
			}
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(`{"message":"nope"}`))
		}))
		_, err := NewClient("tok").WithBase(srv.URL).GetIssue(t.Context(), "a", "b", 1)
		srv.Close()
		api, ok := err.(*APIError)
		if !ok {
			t.Fatalf("%s: error %T %v", c.name, err, err)
		}
		if api.IsAuth() != c.auth || (!api.RetryAt.IsZero()) != c.limited {
			t.Errorf("%s: IsAuth=%v RetryAt=%v", c.name, api.IsAuth(), api.RetryAt)
		}
		if c.limited && !api.RetryAt.After(time.Now()) {
			t.Errorf("%s: RetryAt %v is not in the future", c.name, api.RetryAt)
		}
	}
}
