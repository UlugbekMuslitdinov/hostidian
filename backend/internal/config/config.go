// Package config reads the API configuration from the environment (see .env.example).
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"

	"hostidian/backend/internal/version"
)

// OIDC is the optional single-sign-on configuration. It is enabled iff issuer, client id and
// client secret are all set.
type OIDC struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	Name         string
	RedirectURL  string
}

func (o OIDC) Enabled() bool {
	return o.IssuerURL != "" && o.ClientID != "" && o.ClientSecret != ""
}

type Config struct {
	// PublicURL is the externally visible base URL without trailing slash (https://notes.example.com).
	PublicURL string
	// PublicOrigin is scheme://host[:port] of PublicURL.
	PublicOrigin string
	// CookieSecure is true when PublicURL is https.
	CookieSecure bool
	// AllowedOrigins are the browser origins accepted by the CSRF check (PublicOrigin included).
	AllowedOrigins []string

	DatabaseURL string

	CollabJWTSecret string
	InternalToken   string
	AppSecret       string

	APIAddr      string
	InternalAddr string

	// CollabInternalURL is where the API reaches the collab service; empty disables revocation calls.
	CollabInternalURL string
	// CollabPublicURL is the browser-facing WebSocket URL handed out with collab tokens.
	CollabPublicURL string

	DataDir     string
	MaxUploadMB int
	MaxImportMB int
	LogLevel    slog.Level

	OIDC OIDC

	// MCPEnabled serves the MCP endpoint (/api/mcp); when false it answers 404. Default true.
	MCPEnabled bool

	Version string
}

// Load reads the configuration from the process environment.
func Load() (*Config, error) { return FromEnv(os.Getenv) }

// FromEnv builds a Config from an arbitrary lookup function (tests pass a map).
func FromEnv(getenv func(string) string) (*Config, error) {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}

	var problems []string
	c := &Config{
		DatabaseURL:       get("DATABASE_URL", ""),
		CollabJWTSecret:   get("COLLAB_JWT_SECRET", ""),
		InternalToken:     get("INTERNAL_TOKEN", ""),
		AppSecret:         get("APP_SECRET", ""),
		APIAddr:           get("API_ADDR", ":8080"),
		InternalAddr:      get("INTERNAL_ADDR", ":8081"),
		CollabInternalURL: strings.TrimRight(get("COLLAB_INTERNAL_URL", ""), "/"),
		DataDir:           get("DATA_DIR", "./data"),
		Version:           version.Version,
	}
	for key, val := range map[string]string{
		"DATABASE_URL":      c.DatabaseURL,
		"COLLAB_JWT_SECRET": c.CollabJWTSecret,
		"INTERNAL_TOKEN":    c.InternalToken,
		"APP_SECRET":        c.AppSecret,
	} {
		if val == "" {
			problems = append(problems, key+" is required")
		}
	}

	pub, err := parseOrigin(get("PUBLIC_URL", "http://localhost:8080"))
	if err != nil {
		problems = append(problems, "PUBLIC_URL: "+err.Error())
	} else {
		c.PublicURL = pub.base
		c.PublicOrigin = pub.origin
		c.CookieSecure = pub.scheme == "https"
		c.AllowedOrigins = append(c.AllowedOrigins, pub.origin)
		c.CollabPublicURL = pub.wsBase + "/collab"
	}
	for _, raw := range strings.Split(getenv("ALLOWED_ORIGINS"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		o, err := parseOrigin(raw)
		if err != nil {
			problems = append(problems, "ALLOWED_ORIGINS: "+err.Error())
			continue
		}
		c.AllowedOrigins = append(c.AllowedOrigins, o.origin)
	}
	if v := get("COLLAB_PUBLIC_URL", ""); v != "" {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
			problems = append(problems, "COLLAB_PUBLIC_URL must be a ws:// or wss:// URL")
		} else {
			c.CollabPublicURL = strings.TrimRight(v, "/")
		}
	}

	if c.MaxUploadMB, err = strconv.Atoi(get("MAX_UPLOAD_MB", "50")); err != nil || c.MaxUploadMB < 1 {
		problems = append(problems, "MAX_UPLOAD_MB must be a positive integer")
	}
	if c.MaxImportMB, err = strconv.Atoi(get("MAX_IMPORT_MB", "500")); err != nil || c.MaxImportMB < 1 {
		problems = append(problems, "MAX_IMPORT_MB must be a positive integer")
	}
	if err := c.LogLevel.UnmarshalText([]byte(get("LOG_LEVEL", "info"))); err != nil {
		problems = append(problems, "LOG_LEVEL must be debug, info, warn or error")
	}

	c.MCPEnabled = true
	switch strings.ToLower(get("MCP_ENABLED", "true")) {
	case "true", "1", "yes", "on":
	case "false", "0", "no", "off":
		c.MCPEnabled = false
	default:
		problems = append(problems, "MCP_ENABLED must be true or false")
	}

	c.OIDC = OIDC{
		IssuerURL:    get("OIDC_ISSUER_URL", ""),
		ClientID:     get("OIDC_CLIENT_ID", ""),
		ClientSecret: get("OIDC_CLIENT_SECRET", ""),
		Name:         get("OIDC_NAME", "Single sign-on"),
		RedirectURL:  c.PublicURL + "/api/auth/oidc/callback",
	}

	if len(problems) > 0 {
		return nil, errors.New("invalid configuration: " + strings.Join(problems, "; "))
	}
	return c, nil
}

// WeakSecrets lists secrets still carrying the placeholder from .env.example, for a startup warning.
func (c *Config) WeakSecrets() []string {
	var weak []string
	for name, v := range map[string]string{
		"COLLAB_JWT_SECRET": c.CollabJWTSecret,
		"INTERNAL_TOKEN":    c.InternalToken,
		"APP_SECRET":        c.AppSecret,
	} {
		if v == "change-me" || len(v) < 16 {
			weak = append(weak, name)
		}
	}
	return weak
}

type origin struct {
	scheme, origin, base, wsBase string
}

func parseOrigin(raw string) (origin, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return origin{}, fmt.Errorf("%q must be an absolute http(s) URL", raw)
	}
	o := origin{scheme: u.Scheme, origin: u.Scheme + "://" + strings.ToLower(u.Host)}
	o.base = o.origin + strings.TrimRight(u.Path, "/")
	o.wsBase = "ws" + strings.TrimPrefix(o.origin, "http")
	return o, nil
}
