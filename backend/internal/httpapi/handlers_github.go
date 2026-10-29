package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/githubsync"
	"hostidian/backend/internal/httpapi/gen"
)

// maxWebhookBody bounds a delivery; GitHub itself caps payloads at 25 MB but the sync only needs routing data.
const maxWebhookBody = 5 << 20

// githubSync returns the GitHub sync service (nil if its secrets cannot be set up). It is built lazily because
// it needs the page, comment and collab services.
func githubSync(s *Server) *githubsync.Service {
	return Ext(s, "githubsync", func() *githubsync.Service {
		vault, err := githubsync.NewVault(s.Config.AppSecret)
		if err != nil {
			s.Log.Error("github sync disabled", "err", err)
			return nil
		}
		// The production Collab client applies edits; test doubles fall back to one built from the configuration.
		applier, ok := s.Collab.(collabclient.Applier)
		if !ok {
			applier = collabclient.New(s.Config.CollabInternalURL, s.Config.InternalToken, s.Log)
		}
		return githubsync.NewService(githubsync.NewEngine(githubsync.Options{
			Pool: s.Pool, Q: s.Deps.Q, Vault: vault, Pages: s.Pages, Comments: commentsService(s), Collab: applier,
			Broker: s.Broker, PublicURL: s.Config.PublicURL, Log: s.Log,
			NewClient: func(token string) *githubsync.Client {
				c := githubsync.NewClient(token)
				if s.githubAPIBase != "" {
					c.WithBase(s.githubAPIBase)
				}
				return c
			},
		}))
	})
}

// RunGitHubSync runs the background sync worker until ctx ends.
func (s *Server) RunGitHubSync(ctx context.Context) {
	if svc := githubSync(s); svc != nil {
		svc.Run(ctx)
	}
}

// githubService answers 503 itself when the service is unavailable.
func (s *Server) githubService(w http.ResponseWriter) (*githubsync.Service, bool) {
	svc := githubSync(s)
	if svc == nil {
		writeAppError(w, apperr.New(http.StatusServiceUnavailable, apperr.CodeInternal, "GitHub sync is not available on this instance."))
		return nil, false
	}
	return svc, true
}

func toGenConnection(c githubsync.ConnectionInfo) gen.GithubConnection {
	out := gen.GithubConnection{
		Id: c.ID, WorkspaceId: c.WorkspaceID, Repository: c.Repository, Enabled: c.Enabled, SyncUserId: c.SyncUserID,
		WebhookUrl: c.WebhookURL, WebhookSecret: c.WebhookSecret, Backfilled: c.Backfilled,
		LastSyncedAt: c.LastSyncedAt, LastError: c.LastError, CreatedAt: c.CreatedAt,
	}
	if c.RootPageID != nil {
		out.RootPageId = c.RootPageID
	}
	return out
}

func toGenPageGithub(l *githubsync.PageLinkInfo) *gen.PageGithub {
	if l == nil {
		return nil
	}
	return &gen.PageGithub{
		ConnectionId: l.ConnectionID, Repository: l.Repository, Number: int(l.Number), Url: l.URL,
		State: gen.GithubIssueState(l.State), LastSyncedAt: l.LastSyncedAt, Error: l.Error,
	}
}

// ListGithubConnections: GET /workspaces/{workspaceId}/integrations/github
func (s *Server) ListGithubConnections(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	list, err := svc.List(r.Context(), p.User.ID, uuid.UUID(workspaceId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]gen.GithubConnection, 0, len(list))
	for _, c := range list {
		out = append(out, toGenConnection(c))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateGithubConnection: POST /workspaces/{workspaceId}/integrations/github
func (s *Server) CreateGithubConnection(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.CreateGithubConnectionJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	c, err := svc.Connect(r.Context(), p.User.ID, uuid.UUID(workspaceId), body.Repository, body.Token)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toGenConnection(c))
}

// UpdateGithubConnection: PATCH /integrations/github/{connectionId}
func (s *Server) UpdateGithubConnection(w http.ResponseWriter, r *http.Request, connectionId gen.GithubConnectionId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.UpdateGithubConnectionJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	c, err := svc.Update(r.Context(), p.User.ID, uuid.UUID(connectionId), body.Enabled, body.Token)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toGenConnection(c))
}

// DeleteGithubConnection: DELETE /integrations/github/{connectionId}
func (s *Server) DeleteGithubConnection(w http.ResponseWriter, r *http.Request, connectionId gen.GithubConnectionId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	if err := svc.Delete(r.Context(), p.User.ID, uuid.UUID(connectionId)); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SyncGithubConnection: POST /integrations/github/{connectionId}/sync
func (s *Server) SyncGithubConnection(w http.ResponseWriter, r *http.Request, connectionId gen.GithubConnectionId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	if err := svc.SyncNow(r.Context(), p.User.ID, uuid.UUID(connectionId)); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// ListGithubIssues: GET /workspaces/{workspaceId}/github-issues
func (s *Server) ListGithubIssues(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	refs, err := svc.Index(r.Context(), p.User.ID, uuid.UUID(workspaceId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]gen.GithubIssueRef, 0, len(refs))
	for _, ref := range refs {
		out = append(out, gen.GithubIssueRef{
			PageId: ref.PageID, Number: int(ref.Number), Repository: ref.Repository, State: gen.GithubIssueState(ref.State), Url: ref.URL,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// SetGithubIssueState: PUT /pages/{pageId}/github/state
func (s *Server) SetGithubIssueState(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc, ok := s.githubService(w)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.SetGithubIssueStateJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	link, err := svc.SetState(r.Context(), p.User.ID, uuid.UUID(pageId), string(body.State))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toGenPageGithub(link))
}

// mountGithubWebhook registers GitHub's delivery endpoint. Like /api/mcp it lives outside the generated router:
// GitHub sends no session cookie and no Origin header, and authenticates with an HMAC signature instead.
func (s *Server) mountGithubWebhook(root chi.Router) {
	root.Post(githubsync.WebhookPath+"{connectionId}", s.githubWebhook)
}

func (s *Server) githubWebhook(w http.ResponseWriter, r *http.Request) {
	svc := githubSync(s)
	id, err := uuid.Parse(chi.URLParam(r, "connectionId"))
	if svc == nil || err != nil {
		writeAppError(w, apperr.NotFound("No such endpoint."))
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		writeAppError(w, apperr.PayloadTooLarge("Payload too large."))
		return
	}
	err = svc.HandleWebhook(r.Context(), id, r.Header.Get("X-GitHub-Event"), r.Header.Get("X-Hub-Signature-256"), body)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusAccepted)
	case errors.Is(err, githubsync.ErrUnknownConnection):
		writeAppError(w, apperr.NotFound("No such endpoint."))
	case errors.Is(err, githubsync.ErrBadSignature):
		writeAppError(w, apperr.Unauthorized("Invalid signature."))
	default:
		s.writeError(w, r, err)
	}
}
