package githubsync

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/perm"
)

// WebhookPath is where GitHub delivers events; the connection id is appended.
const WebhookPath = "/api/integrations/github/webhook/"

const (
	maxTokenLen = 255
	pollEvery   = time.Minute
	tickEvery   = 10 * time.Second
)

var (
	// ErrUnknownConnection: the webhook URL names no connection (answered with 404).
	ErrUnknownConnection = errors.New("githubsync: unknown connection")
	// ErrBadSignature: the delivery is not signed with the connection's secret (answered with 401).
	ErrBadSignature = errors.New("githubsync: bad webhook signature")
)

// Service is the API-facing side of the integration plus the background worker.
type Service struct {
	e    *Engine
	wake chan struct{}
	// pollEvery is overridable for tests.
	pollEvery time.Duration
}

// NewService wraps an engine.
func NewService(e *Engine) *Service {
	return &Service{e: e, wake: make(chan struct{}, 1), pollEvery: pollEvery}
}

// Engine exposes the engine (tests, state changes).
func (s *Service) Engine() *Engine { return s.e }

// Nudge asks the worker to look at the connections now instead of at the next tick.
func (s *Service) Nudge() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// ---------------------------------------------------------------- connections

// ConnectionInfo is what admins see. The token is write-only; the webhook secret is shown so it can be pasted
// into GitHub's webhook settings.
type ConnectionInfo struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	Repository    string
	Enabled       bool
	RootPageID    *uuid.UUID
	SyncUserID    uuid.UUID
	WebhookURL    string
	WebhookSecret string
	Backfilled    bool
	LastSyncedAt  *time.Time
	LastError     *string
	CreatedAt     time.Time
}

func (s *Service) info(c sqlcgen.GithubConnection) ConnectionInfo {
	secret := ""
	if b, err := s.e.o.Vault.Open(c.WebhookSecretEnc); err == nil {
		secret = string(b)
	}
	return ConnectionInfo{
		ID: c.ID, WorkspaceID: c.WorkspaceID, Repository: c.Owner + "/" + c.Repo, Enabled: c.Enabled,
		RootPageID: c.RootPageID, SyncUserID: c.SyncUserID,
		WebhookURL: s.e.o.PublicURL + WebhookPath + c.ID.String(), WebhookSecret: secret,
		Backfilled: c.BackfilledAt != nil, LastSyncedAt: c.LastSyncedAt, LastError: c.LastError, CreatedAt: c.CreatedAt,
	}
}

func checkToken(token string) (string, error) {
	token = strings.TrimSpace(token)
	switch {
	case token == "":
		return "", apperr.FieldError("token", "This field is required.")
	case len(token) > maxTokenLen || strings.ContainsAny(token, " \t\r\n"):
		return "", apperr.FieldError("token", "This does not look like a GitHub token.")
	}
	return token, nil
}

// verifyAccess proves the token can read the repository before anything is stored.
func (s *Service) verifyAccess(ctx context.Context, token, owner, repo string) error {
	r, err := s.e.o.NewClient(token).GetRepo(ctx, owner, repo)
	var api *APIError
	switch {
	case errors.As(err, &api) && api.IsAuth():
		return apperr.FieldError("token", "GitHub rejected this token.")
	case errors.As(err, &api) && api.Status == http.StatusNotFound:
		return apperr.FieldError("repository", "GitHub cannot find this repository, or the token cannot see it.")
	case errors.As(err, &api) && !api.RetryAt.IsZero():
		return apperr.Validation("GitHub rate limit reached; try again in a minute.", nil)
	case err != nil:
		return apperr.Validation("Could not reach GitHub; try again.", nil)
	case !r.HasIssues:
		return apperr.FieldError("repository", "Issues are disabled for this repository.")
	}
	return nil
}

// Connect links a repository to a workspace and schedules the initial import.
func (s *Service) Connect(ctx context.Context, userID, workspaceID uuid.UUID, repository, token string) (ConnectionInfo, error) {
	if _, err := perm.RequireWorkspaceAdmin(ctx, s.e.o.Q, workspaceID, userID); err != nil {
		return ConnectionInfo{}, err
	}
	owner, repo, ok := ParseRepository(repository)
	if !ok {
		return ConnectionInfo{}, apperr.FieldError("repository", "Enter the repository as owner/name, for example acme/website.")
	}
	token, err := checkToken(token)
	if err != nil {
		return ConnectionInfo{}, err
	}
	if err := s.verifyAccess(ctx, token, owner, repo); err != nil {
		return ConnectionInfo{}, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return ConnectionInfo{}, apperr.Internal(err)
	}
	tokenEnc, err := s.e.o.Vault.Seal([]byte(token))
	if err != nil {
		return ConnectionInfo{}, apperr.Internal(err)
	}
	secretEnc, err := s.e.o.Vault.Seal([]byte(hex.EncodeToString(secret)))
	if err != nil {
		return ConnectionInfo{}, apperr.Internal(err)
	}
	c, err := s.e.o.Q.InsertGithubConnection(ctx, sqlcgen.InsertGithubConnectionParams{
		WorkspaceID: workspaceID, Owner: owner, Repo: repo, TokenEnc: tokenEnc, WebhookSecretEnc: secretEnc, SyncUserID: userID,
	})
	if err != nil {
		if db.IsUniqueViolation(err) {
			return ConnectionInfo{}, apperr.Conflict("This repository is already connected to the workspace.")
		}
		return ConnectionInfo{}, apperr.Internal(err)
	}
	s.request(ctx, c.ID)
	return s.info(c), nil
}

// List returns a workspace's connections (admins only).
func (s *Service) List(ctx context.Context, userID, workspaceID uuid.UUID) ([]ConnectionInfo, error) {
	if _, err := perm.RequireWorkspaceAdmin(ctx, s.e.o.Q, workspaceID, userID); err != nil {
		return nil, err
	}
	rows, err := s.e.o.Q.ListGithubConnections(ctx, workspaceID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	out := make([]ConnectionInfo, 0, len(rows))
	for _, c := range rows {
		out = append(out, s.info(c))
	}
	return out, nil
}

func (s *Service) adminOf(ctx context.Context, userID, connID uuid.UUID) (sqlcgen.GithubConnection, error) {
	c, err := s.e.o.Q.GetGithubConnection(ctx, connID)
	if err != nil {
		if db.IsNotFound(err) {
			return c, apperr.NotFound("Connection not found.")
		}
		return c, apperr.Internal(err)
	}
	if _, err := perm.RequireWorkspaceAdmin(ctx, s.e.o.Q, c.WorkspaceID, userID); err != nil {
		return c, apperr.NotFound("Connection not found.") // do not reveal connections of other workspaces
	}
	return c, nil
}

// Update pauses/resumes a connection or replaces its token. Replacing the token makes the caller the user that
// GitHub-originated edits are attributed to.
func (s *Service) Update(ctx context.Context, userID, connID uuid.UUID, enabled *bool, token *string) (ConnectionInfo, error) {
	c, err := s.adminOf(ctx, userID, connID)
	if err != nil {
		return ConnectionInfo{}, err
	}
	p := sqlcgen.UpdateGithubConnectionParams{ID: connID, Enabled: enabled}
	if token != nil {
		t, err := checkToken(*token)
		if err != nil {
			return ConnectionInfo{}, err
		}
		if err := s.verifyAccess(ctx, t, c.Owner, c.Repo); err != nil {
			return ConnectionInfo{}, err
		}
		if p.TokenEnc, err = s.e.o.Vault.Seal([]byte(t)); err != nil {
			return ConnectionInfo{}, apperr.Internal(err)
		}
		p.SyncUserID = &userID
	}
	updated, err := s.e.o.Q.UpdateGithubConnection(ctx, p)
	if err != nil {
		return ConnectionInfo{}, apperr.Internal(err)
	}
	if token != nil || (enabled != nil && *enabled) {
		s.request(ctx, connID)
	}
	return s.info(updated), nil
}

// Delete disconnects the repository. The synced pages stay as ordinary pages; nothing is removed from GitHub.
func (s *Service) Delete(ctx context.Context, userID, connID uuid.UUID) error {
	if _, err := s.adminOf(ctx, userID, connID); err != nil {
		return err
	}
	// No lock: the cascade removes the links, so a pass that is still running fails on its next write and stops.
	if _, err := s.e.o.Q.DeleteGithubConnection(ctx, connID); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SyncNow schedules an immediate pass.
func (s *Service) SyncNow(ctx context.Context, userID, connID uuid.UUID) error {
	if _, err := s.adminOf(ctx, userID, connID); err != nil {
		return err
	}
	s.request(ctx, connID)
	return nil
}

func (s *Service) request(ctx context.Context, connID uuid.UUID) {
	if err := s.e.o.Q.RequestGithubSync(ctx, connID); err != nil {
		s.e.o.Log.Warn("github sync: request", "connection", connID, "err", err)
	}
	s.Nudge()
}

// ---------------------------------------------------------------- per page

// PageLinkInfo is the sync state shown in a synced page's header.
type PageLinkInfo struct {
	ConnectionID uuid.UUID
	Repository   string
	Number       int32
	URL          string
	State        string
	LastSyncedAt time.Time
	Error        *string
}

// PageLink returns the link of a page, or nil when it is not synced. The caller has already checked that the user
// may view the page.
func (s *Service) PageLink(ctx context.Context, pageID uuid.UUID) (*PageLinkInfo, error) {
	l, err := s.e.o.Q.GetGithubLinkDetail(ctx, pageID)
	if err != nil {
		if db.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return &PageLinkInfo{
		ConnectionID: l.ConnectionID, Repository: l.Owner + "/" + l.Repo, Number: l.IssueNumber, URL: l.HtmlUrl,
		State: l.BaseState, LastSyncedAt: l.LastSyncedAt, Error: l.SyncError,
	}, nil
}

// SetState closes or reopens the issue behind a page (needs edit on the page).
func (s *Service) SetState(ctx context.Context, userID, pageID uuid.UUID, state string) (*PageLinkInfo, error) {
	if state != "open" && state != "closed" {
		return nil, apperr.FieldError("state", "Must be open or closed.")
	}
	if _, err := perm.Require(ctx, s.e.o.Q, userID, pageID, perm.Edit); err != nil {
		return nil, err
	}
	if _, err := s.e.o.Q.GetGithubIssueLinkByPage(ctx, pageID); err != nil {
		if db.IsNotFound(err) {
			return nil, apperr.NotFound("This page is not linked to a GitHub issue.")
		}
		return nil, apperr.Internal(err)
	}
	if err := s.e.SetIssueState(ctx, userID, pageID, state); err != nil {
		if errors.Is(err, ErrSyncBusy) {
			return nil, apperr.Conflict("A sync with GitHub is running right now; try again in a moment.")
		}
		var api *APIError
		if errors.As(err, &api) {
			return nil, apperr.Validation("GitHub could not change the issue: "+userMessage(err), nil)
		}
		return nil, err
	}
	return s.PageLink(ctx, pageID)
}

// IssueRef is one entry of the `[[#123]]` index.
type IssueRef struct {
	PageID     uuid.UUID
	Number     int32
	Repository string
	State      string
	URL        string
}

// Index lists the synced pages of a workspace the user can see.
func (s *Service) Index(ctx context.Context, userID, workspaceID uuid.UUID) ([]IssueRef, error) {
	if _, err := perm.RequireMember(ctx, s.e.o.Q, workspaceID, userID); err != nil {
		return nil, err
	}
	rows, err := s.e.o.Q.ListGithubLinksForWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	roles, err := perm.ResolveWorkspace(ctx, s.e.o.Q, workspaceID, userID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	out := make([]IssueRef, 0, len(rows))
	for _, r := range rows {
		if roles[r.PageID].AtLeast(perm.View) {
			out = append(out, IssueRef{PageID: r.PageID, Number: r.IssueNumber, Repository: r.Owner + "/" + r.Repo, State: r.BaseState, URL: r.HtmlUrl})
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- webhook

// HandleWebhook authenticates a delivery and schedules a pull. event is X-GitHub-Event and signature is
// X-Hub-Signature-256. The body is not trusted for anything beyond routing: all data is re-read through the API.
func (s *Service) HandleWebhook(ctx context.Context, connID uuid.UUID, event, signature string, body []byte) error {
	c, err := s.e.o.Q.GetGithubConnection(ctx, connID)
	if err != nil {
		if db.IsNotFound(err) {
			return ErrUnknownConnection
		}
		return err
	}
	secret, err := s.e.o.Vault.Open(c.WebhookSecretEnc)
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(signature)) {
		return ErrBadSignature
	}
	if !c.Enabled || event == "ping" {
		return nil
	}

	var payload struct {
		Action  string `json:"action"`
		Comment struct {
			ID int64 `json:"id"`
		} `json:"comment"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Repository.FullName != "" &&
		!strings.EqualFold(payload.Repository.FullName, c.Owner+"/"+c.Repo) {
		return nil // a delivery for another repository (shared webhook URL)
	}
	if event == "issue_comment" && payload.Action == "deleted" && payload.Comment.ID != 0 {
		// Deletions do not appear in the polling feed, so they are applied from the event itself.
		go func() {
			bg, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := s.e.DeleteMirroredComment(bg, connID, payload.Comment.ID); err != nil {
				s.e.o.Log.Warn("github sync: delete mirrored comment", "connection", connID, "err", err)
			}
		}()
	}
	s.request(ctx, connID)
	return nil
}

// Sign computes the signature GitHub would send for body (tests, docs).
func Sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// ---------------------------------------------------------------- worker

type connState struct {
	lastPull   time.Time
	notBefore  time.Time
	lastFailed bool
}

// Run drives the connections until ctx ends: a pull about once a minute (immediately after a webhook or a
// "sync now"), and a push whenever there are local changes that have settled.
func (s *Service) Run(ctx context.Context) {
	tick := time.NewTicker(tickEvery)
	defer tick.Stop()
	state := map[uuid.UUID]*connState{}
	for {
		s.pass(ctx, state)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-s.wake:
		}
	}
}

func (s *Service) pass(ctx context.Context, state map[uuid.UUID]*connState) {
	conns, err := s.e.o.Q.ListEnabledGithubConnections(ctx)
	if err != nil {
		if ctx.Err() == nil {
			s.e.o.Log.Warn("github sync: list connections", "err", err)
		}
		return
	}
	live := make(map[uuid.UUID]bool, len(conns))
	for _, c := range conns {
		live[c.ID] = true
		st := state[c.ID]
		if st == nil {
			st = &connState{}
			state[c.ID] = st
		}
		now := s.e.o.Now()
		if now.Before(st.notBefore) {
			continue
		}
		pull := c.SyncRequestedAt != nil || c.RootPageID == nil || c.BackfilledAt == nil || now.Sub(st.lastPull) >= s.pollEvery
		push := false
		if !pull {
			push, err = s.e.o.Q.HasGithubLocalWork(ctx, sqlcgen.HasGithubLocalWorkParams{
				ConnectionID: c.ID, SettledBefore: now.Add(-s.e.o.Settle),
			})
			if err != nil {
				s.e.o.Log.Warn("github sync: probe", "connection", c.ID, "err", err)
				continue
			}
		}
		if !pull && !push {
			continue
		}
		run, cancel := context.WithTimeout(ctx, 10*time.Minute)
		err := s.e.Sync(run, c.ID, Mode{Pull: pull, Push: true})
		cancel()
		if pull {
			st.lastPull = now
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			st.notBefore = BackoffUntil(err, now)
			if !st.lastFailed {
				s.e.o.Log.Warn("github sync: pass failed", "connection", c.ID, "repo", c.Owner+"/"+c.Repo, "err", userMessage(err))
			}
		}
		st.lastFailed = err != nil
	}
	for id := range state {
		if !live[id] {
			delete(state, id)
		}
	}
}
