package validate

import (
	"strings"
	"testing"
)

func TestEmail(t *testing.T) {
	ok := map[string]string{"A@B.co": "a@b.co", "  user+tag@Example.COM ": "user+tag@example.com", "me@localhost": "me@localhost"}
	for in, want := range ok {
		if got, err := Email("email", in); err != nil || got != want {
			t.Errorf("Email(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "plain", "@x.com", "a@", "a b@c.com", "Name <a@b.com>", "a@b.com, c@d.com", strings.Repeat("a", 250) + "@b.com"} {
		if _, err := Email("email", bad); err == nil {
			t.Errorf("Email(%q) should be invalid", bad)
		}
	}
}

func TestPasswordAndName(t *testing.T) {
	if Password("p", "123456789") == nil || Password("p", "1234567890") != nil || Password("p", strings.Repeat("x", 201)) == nil {
		t.Fatal("password length rules (10..200)")
	}
	if Password("p", "ééééééééé") == nil || Password("p", "éééééééééé") != nil {
		t.Fatal("password length counts characters, not bytes")
	}
	if _, err := Name("n", "   "); err == nil {
		t.Fatal("blank names are invalid")
	}
	if got, err := Name("n", "  Ada  "); err != nil || got != "Ada" {
		t.Fatalf("Name = %q %v", got, err)
	}
	if _, err := Name("n", "a\x00b"); err == nil {
		t.Fatal("control characters are invalid")
	}
	if _, err := Name("n", strings.Repeat("é", 101)); err == nil {
		t.Fatal("101 characters is too long")
	}
}

func TestSlug(t *testing.T) {
	for _, s := range []string{"a", "my-team", "team-2", "a1-b2-c3"} {
		if Slug("slug", s) != nil {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range []string{"", "-a", "a-", "a--b", "A", "a_b", "a b", strings.Repeat("a", 61)} {
		if Slug("slug", s) == nil {
			t.Errorf("%q should be invalid", s)
		}
	}
	for in, want := range map[string]string{
		"My Workspace": "my-workspace", "Bob's Place!": "bob-s-place", "  --Hi--  ": "hi", "ÄÖÜ": "", "日本語": "", "a/b\\c": "a-b-c",
		strings.Repeat("ab ", 40): strings.Repeat("ab-", 20)[:59] + "",
	} {
		got := Slugify(in)
		if len(want) > 0 && in != "My Workspace" && strings.HasPrefix(in, "ab ") {
			if len(got) > MaxSlugLen || got == "" || strings.HasSuffix(got, "-") {
				t.Errorf("Slugify(long) = %q", got)
			}
			continue
		}
		if got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestColorAndTitle(t *testing.T) {
	if AvatarColor("c", "#aBc123") != nil || AvatarColor("c", "aBc123") == nil || AvatarColor("c", "#abc") == nil {
		t.Fatal("avatar colour must be #rrggbb")
	}
	if Title("t", strings.Repeat("é", 500)) != nil || Title("t", strings.Repeat("é", 501)) == nil {
		t.Fatal("titles are limited to 500 characters")
	}
}
