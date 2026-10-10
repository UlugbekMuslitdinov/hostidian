package config

import (
	"log/slog"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

var required = map[string]string{
	"DATABASE_URL": "postgres://u:p@db/x", "COLLAB_JWT_SECRET": "cs", "INTERNAL_TOKEN": "it", "APP_SECRET": "as",
}

func with(extra map[string]string) map[string]string {
	m := map[string]string{}
	for k, v := range required {
		m[k] = v
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestDefaultsAndDerivedValues(t *testing.T) {
	c, err := FromEnv(env(with(map[string]string{"PUBLIC_URL": "https://Notes.Example.com/", "ALLOWED_ORIGINS": " http://localhost:3000/ , ,https://other.test "})))
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL != "https://notes.example.com" || c.PublicOrigin != "https://notes.example.com" || !c.CookieSecure {
		t.Fatalf("public: %+v", c)
	}
	if c.CollabPublicURL != "wss://notes.example.com/collab" {
		t.Fatalf("collab url = %q", c.CollabPublicURL)
	}
	want := []string{"https://notes.example.com", "http://localhost:3000", "https://other.test"}
	if strings.Join(c.AllowedOrigins, ",") != strings.Join(want, ",") {
		t.Fatalf("allowed origins = %v", c.AllowedOrigins)
	}
	if c.APIAddr != ":8080" || c.InternalAddr != ":8081" || c.MaxUploadMB != 50 || c.LogLevel != slog.LevelInfo || c.CollabInternalURL != "" {
		t.Fatalf("defaults: %+v", c)
	}
	if c.OIDC.Enabled() || c.OIDC.RedirectURL != "https://notes.example.com/api/auth/oidc/callback" || c.OIDC.Name != "Single sign-on" {
		t.Fatalf("oidc: %+v", c.OIDC)
	}
}

func TestHTTPPublicURLIsNotSecure(t *testing.T) {
	c, err := FromEnv(env(with(map[string]string{"PUBLIC_URL": "http://localhost:3000"})))
	if err != nil {
		t.Fatal(err)
	}
	if c.CookieSecure || c.CollabPublicURL != "ws://localhost:3000/collab" {
		t.Fatalf("%+v", c)
	}
}

func TestExplicitOverrides(t *testing.T) {
	c, err := FromEnv(env(with(map[string]string{
		"COLLAB_PUBLIC_URL": "wss://collab.example.com/ws/", "COLLAB_INTERNAL_URL": "http://collab:1235/", "LOG_LEVEL": "debug", "MAX_UPLOAD_MB": "7",
		"OIDC_ISSUER_URL": "https://idp", "OIDC_CLIENT_ID": "id", "OIDC_CLIENT_SECRET": "s", "OIDC_NAME": "Corp",
	})))
	if err != nil {
		t.Fatal(err)
	}
	if c.CollabPublicURL != "wss://collab.example.com/ws" || c.CollabInternalURL != "http://collab:1235" || c.LogLevel != slog.LevelDebug || c.MaxUploadMB != 7 {
		t.Fatalf("%+v", c)
	}
	if !c.OIDC.Enabled() || c.OIDC.Name != "Corp" {
		t.Fatalf("oidc: %+v", c.OIDC)
	}
}

func TestOIDCNeedsAllThree(t *testing.T) {
	for _, partial := range []map[string]string{
		{"OIDC_ISSUER_URL": "https://idp"},
		{"OIDC_ISSUER_URL": "https://idp", "OIDC_CLIENT_ID": "id"},
		{"OIDC_CLIENT_ID": "id", "OIDC_CLIENT_SECRET": "s"},
	} {
		c, err := FromEnv(env(with(partial)))
		if err != nil {
			t.Fatal(err)
		}
		if c.OIDC.Enabled() {
			t.Fatalf("OIDC enabled with %v", partial)
		}
	}
}

func TestValidation(t *testing.T) {
	_, err := FromEnv(env(map[string]string{}))
	if err == nil {
		t.Fatal("missing secrets must fail")
	}
	for _, v := range []string{"DATABASE_URL", "COLLAB_JWT_SECRET", "INTERNAL_TOKEN", "APP_SECRET"} {
		if !strings.Contains(err.Error(), v) {
			t.Errorf("error does not mention %s: %v", v, err)
		}
	}
	for name, extra := range map[string]map[string]string{
		"bad public url":  {"PUBLIC_URL": "notes.example.com"},
		"ftp public url":  {"PUBLIC_URL": "ftp://x"},
		"bad origin":      {"ALLOWED_ORIGINS": "localhost:3000"},
		"bad collab url":  {"COLLAB_PUBLIC_URL": "https://x/collab"},
		"bad upload":      {"MAX_UPLOAD_MB": "0"},
		"bad upload text": {"MAX_UPLOAD_MB": "lots"},
		"bad level":       {"LOG_LEVEL": "loud"},
	} {
		if _, err := FromEnv(env(with(extra))); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestWeakSecrets(t *testing.T) {
	c, _ := FromEnv(env(with(map[string]string{"INTERNAL_TOKEN": "change-me", "APP_SECRET": "a-long-enough-random-value-1234"})))
	weak := strings.Join(c.WeakSecrets(), ",")
	if !strings.Contains(weak, "INTERNAL_TOKEN") || strings.Contains(weak, "APP_SECRET") || !strings.Contains(weak, "COLLAB_JWT_SECRET") {
		t.Fatalf("weak = %q", weak)
	}
}

func TestMCPEnabled(t *testing.T) {
	for value, want := range map[string]bool{"": true, "true": true, "1": true, "false": false, "FALSE": false, "0": false} {
		c, err := FromEnv(env(with(map[string]string{"MCP_ENABLED": value})))
		if err != nil {
			t.Fatalf("MCP_ENABLED=%q: %v", value, err)
		}
		if c.MCPEnabled != want {
			t.Fatalf("MCP_ENABLED=%q: MCPEnabled = %v, want %v", value, c.MCPEnabled, want)
		}
	}
	if _, err := FromEnv(env(with(map[string]string{"MCP_ENABLED": "maybe"}))); err == nil || !strings.Contains(err.Error(), "MCP_ENABLED") {
		t.Fatalf("expected a MCP_ENABLED problem, got %v", err)
	}
}
