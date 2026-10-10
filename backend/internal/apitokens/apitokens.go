// Package apitokens issues, lists, revokes and verifies the personal access tokens agents use on the
// MCP endpoint (conventions §13). A token acts as its owner; scope and an optional workspace
// restriction only narrow what the owner may do.
package apitokens

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/time/rate"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/tokens"
)

const (
	// Prefix marks a token as ours (and lets secret scanners find leaked ones).
	Prefix = "hst_"
	// displayLen is how much of the token is kept in clear for the token list.
	displayLen = 10

	ScopeRead  = "read"
	ScopeWrite = "write"

	maxNameLen        = 100
	maxActiveTokens   = 50
	touchEvery        = 5 * time.Minute
	rateLimitPerMin   = 120
	limiterIdleExpiry = 10 * time.Minute
)

// ErrInvalidToken is returned by Verify for every reason a presented token is unusable (unknown, revoked,
// expired, owner disabled) so callers cannot tell them apart.
var ErrInvalidToken = errors.New("invalid access token")

// Identity is what a verified token stands for.
type Identity struct {
	TokenID uuid.UUID
	UserID  uuid.UUID
	Scope   string
	// WorkspaceID restricts the token to one workspace; nil means all of the user's workspaces.
	WorkspaceID *uuid.UUID
}

// CanWrite reports whether the token may use the mutating tools.
func (i Identity) CanWrite() bool { return i.Scope == ScopeWrite }

// Service manages and verifies tokens.
type Service struct {
	q         *sqlcgen.Queries
	log       *slog.Logger
	now       func() time.Time
	publicURL string

	touchMu sync.Mutex
	touched map[uuid.UUID]time.Time

	limitMu  sync.Mutex
	limiters map[uuid.UUID]*limiterEntry
}

type limiterEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// Options configure NewService.
type Options struct {
	Q         *sqlcgen.Queries
	Log       *slog.Logger
	Now       func() time.Time
	PublicURL string
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Service{
		q: o.Q, log: o.Log, now: o.Now, publicURL: strings.TrimRight(o.PublicURL, "/"),
		touched: map[uuid.UUID]time.Time{}, limiters: map[uuid.UUID]*limiterEntry{},
	}
}

// MCPURL is the absolute MCP endpoint handed to clients.
func (s *Service) MCPURL() string { return s.publicURL + "/api/mcp" }

// CreateInput is the body of POST /auth/tokens.
type CreateInput struct {
	Name          string
	Scope         string
	WorkspaceID   *uuid.UUID
	ExpiresInDays *int
}

// Create issues a token for userID. The secret is only available in the returned value.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, in CreateInput) (gen.CreatedApiToken, error) {
	name := strings.TrimSpace(in.Name)
	switch {
	case name == "" || len([]rune(name)) > maxNameLen:
		return gen.CreatedApiToken{}, apperr.FieldError("name", fmt.Sprintf("Must be between 1 and %d characters.", maxNameLen))
	case in.Scope != ScopeRead && in.Scope != ScopeWrite:
		return gen.CreatedApiToken{}, apperr.FieldError("scope", "Must be read or write.")
	case in.ExpiresInDays != nil && (*in.ExpiresInDays < 1 || *in.ExpiresInDays > 365):
		return gen.CreatedApiToken{}, apperr.FieldError("expiresInDays", "Must be between 1 and 365.")
	}
	if in.WorkspaceID != nil {
		if _, ok, err := perm.MemberRole(ctx, s.q, *in.WorkspaceID, userID); err != nil {
			return gen.CreatedApiToken{}, err
		} else if !ok {
			// Same answer for "does not exist" and "not yours": workspace ids are not enumerable.
			return gen.CreatedApiToken{}, apperr.FieldError("workspaceId", "You are not a member of this workspace.")
		}
	}
	active, err := s.q.CountActiveApiTokens(ctx, userID)
	if err != nil {
		return gen.CreatedApiToken{}, fmt.Errorf("count tokens: %w", err)
	}
	if active >= maxActiveTokens {
		return gen.CreatedApiToken{}, apperr.Conflict(fmt.Sprintf("You can have at most %d active access tokens; revoke one first.", maxActiveTokens))
	}

	secret, err := generate()
	if err != nil {
		return gen.CreatedApiToken{}, err
	}
	var expires *time.Time
	if in.ExpiresInDays != nil {
		t := s.now().Add(time.Duration(*in.ExpiresInDays) * 24 * time.Hour)
		expires = &t
	}
	row, err := s.q.InsertApiToken(ctx, sqlcgen.InsertApiTokenParams{
		UserID: userID, Name: name, TokenHash: tokens.Hash(secret), TokenPrefix: secret[:displayLen],
		Scope: in.Scope, WorkspaceID: in.WorkspaceID, ExpiresAt: expires,
	})
	if err != nil {
		return gen.CreatedApiToken{}, fmt.Errorf("insert token: %w", err)
	}
	s.log.Info("api token created", "token_id", row.ID, "user", userID, "scope", row.Scope, "workspace", row.WorkspaceID, "expires", row.ExpiresAt != nil)
	return gen.CreatedApiToken{
		Token:    secret,
		McpUrl:   s.MCPURL(),
		ApiToken: toAPI(row.ID, row.Name, row.TokenPrefix, row.Scope, row.WorkspaceID, row.ExpiresAt, row.LastUsedAt, row.CreatedAt),
	}, nil
}

// List returns the caller's own tokens (never a secret).
func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]gen.ApiToken, error) {
	rows, err := s.q.ListApiTokensForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list tokens: %w", err)
	}
	out := make([]gen.ApiToken, 0, len(rows))
	for _, r := range rows {
		out = append(out, toAPI(r.ID, r.Name, r.TokenPrefix, r.Scope, r.WorkspaceID, r.ExpiresAt, r.LastUsedAt, r.CreatedAt))
	}
	return out, nil
}

// Revoke kills one of the caller's tokens immediately. Someone else's (or an unknown or already revoked)
// token is a 404.
func (s *Service) Revoke(ctx context.Context, userID, tokenID uuid.UUID) error {
	n, err := s.q.RevokeApiToken(ctx, sqlcgen.RevokeApiTokenParams{ID: tokenID, UserID: userID})
	if err != nil {
		return fmt.Errorf("revoke token: %w", err)
	}
	if n == 0 {
		return apperr.NotFound("Access token not found.")
	}
	s.log.Info("api token revoked", "token_id", tokenID, "user", userID)
	return nil
}

// Verify resolves a presented secret. Every call hits the database, so revocation, expiry and disabled
// users take effect on the very next request.
func (s *Service) Verify(ctx context.Context, secret string) (*Identity, error) {
	if !strings.HasPrefix(secret, Prefix) || len(secret) > 128 {
		return nil, ErrInvalidToken
	}
	row, err := s.q.GetUsableApiTokenByHash(ctx, tokens.Hash(secret))
	if err != nil {
		if db.IsNotFound(err) {
			return nil, ErrInvalidToken
		}
		return nil, fmt.Errorf("look up token: %w", err)
	}
	s.touch(ctx, row.ID, row.LastUsedAt)
	return &Identity{TokenID: row.ID, UserID: row.UserID, Scope: row.Scope, WorkspaceID: row.WorkspaceID}, nil
}

// touch records last use at most every five minutes (in memory first, so most calls do not even try).
func (s *Service) touch(ctx context.Context, id uuid.UUID, lastUsed *time.Time) {
	now := s.now()
	s.touchMu.Lock()
	last, ok := s.touched[id]
	if !ok && lastUsed != nil {
		last = *lastUsed
	}
	if !last.IsZero() && now.Sub(last) < touchEvery {
		s.touched[id] = last
		s.touchMu.Unlock()
		return
	}
	s.touched[id] = now
	if len(s.touched) > 10_000 {
		for k, t := range s.touched {
			if now.Sub(t) > touchEvery {
				delete(s.touched, k)
			}
		}
	}
	s.touchMu.Unlock()
	if err := s.q.TouchApiToken(ctx, id); err != nil {
		s.log.Warn("touch api token failed", "token_id", id, "err", err)
	}
}

// Allow applies the per-token rate limit (120 requests per minute, bursts allowed up to that).
func (s *Service) Allow(id uuid.UUID) bool {
	now := s.now()
	s.limitMu.Lock()
	defer s.limitMu.Unlock()
	e, ok := s.limiters[id]
	if !ok {
		if len(s.limiters) > 10_000 {
			for k, v := range s.limiters {
				if now.Sub(v.seen) > limiterIdleExpiry {
					delete(s.limiters, k)
				}
			}
		}
		e = &limiterEntry{lim: rate.NewLimiter(rate.Every(time.Minute/rateLimitPerMin), rateLimitPerMin)}
		s.limiters[id] = e
	}
	e.seen = now
	return e.lim.AllowN(now, 1)
}

// generate returns hst_ + 32 random bytes, base64url without padding.
func generate() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("read random bytes: %w", err)
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(b), nil
}

func toAPI(id uuid.UUID, name, prefix, scope string, ws *uuid.UUID, expires, lastUsed *time.Time, created time.Time) gen.ApiToken {
	return gen.ApiToken{
		Id: id, Name: name, Prefix: prefix, Scope: gen.TokenScope(scope), WorkspaceId: ws,
		ExpiresAt: expires, LastUsedAt: lastUsed, CreatedAt: created,
	}
}
