package githubsync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/comments"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/pages"
	"hostidian/backend/internal/perm"
)

const (
	iconOpen   = "🟢"
	iconClosed = "🟣"
	iconRoot   = "🐙"

	maxIssueTitle  = 256
	maxCommentText = 9900
	batchSize      = 50
	// pendingRemoteBody marks a link whose GitHub body has not been copied into the page yet; no real hash equals it.
	pendingRemoteBody = "-"
)

// Options configures the Engine.
type Options struct {
	Pool     *pgxpool.Pool
	Q        *sqlcgen.Queries
	Vault    *Vault
	Pages    *pages.Service
	Comments *comments.Service
	// Collab edits the live document of a page; GitHub-originated body changes go through it.
	Collab    collabclient.Applier
	Broker    *events.Broker
	PublicURL string
	Log       *slog.Logger
	Now       func() time.Time
	// NewClient builds the GitHub client for a token (tests point it at a fake server).
	NewClient func(token string) *Client
	// Settle is how long a page must be quiet before its edits are pushed (the editor stores every few seconds).
	Settle time.Duration
	// NewPageSettle is the same for a page that has no issue yet: titles are typed letter by letter.
	NewPageSettle time.Duration
	// LockWait is how long a user action (closing an issue) waits for a running pass before giving up.
	LockWait time.Duration
}

// Engine reconciles connections. Sync calls for one connection are serialised.
type Engine struct {
	o  Options
	mu sync.Mutex
	// locks holds one binary semaphore per connection (a channel, so waiting can time out).
	locks map[uuid.UUID]chan struct{}
}

// ErrSyncBusy: a sync pass holds the connection and did not finish within Options.LockWait.
var ErrSyncBusy = errors.New("githubsync: a sync is running")

// NewEngine returns an Engine with defaults filled in.
func NewEngine(o Options) *Engine {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.NewClient == nil {
		o.NewClient = NewClient
	}
	if o.Settle == 0 {
		o.Settle = 15 * time.Second
	}
	if o.NewPageSettle == 0 {
		o.NewPageSettle = 30 * time.Second
	}
	if o.LockWait == 0 {
		o.LockWait = 15 * time.Second
	}
	return &Engine{o: o, locks: map[uuid.UUID]chan struct{}{}}
}

func (e *Engine) sem(id uuid.UUID) chan struct{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	c, ok := e.locks[id]
	if !ok {
		c = make(chan struct{}, 1)
		e.locks[id] = c
	}
	return c
}

// lock blocks until the connection is free (background work).
func (e *Engine) lock(id uuid.UUID) func() {
	c := e.sem(id)
	c <- struct{}{}
	return func() { <-c }
}

// lockWithin gives up after Options.LockWait (user actions must not hang behind a long import).
func (e *Engine) lockWithin(ctx context.Context, id uuid.UUID) (func(), error) {
	c := e.sem(id)
	t := time.NewTimer(e.o.LockWait)
	defer t.Stop()
	select {
	case c <- struct{}{}:
		return func() { <-c }, nil
	case <-t.C:
		return nil, ErrSyncBusy
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Mode selects the directions of one sync pass.
type Mode struct {
	Pull bool
	Push bool
}

// Sync runs one pass for a connection. Failures of single items are recorded on their page and do not stop the
// pass; the returned error is a connection-level failure (bad token, rate limit, GitHub unreachable) and is
// also stored on the connection.
func (e *Engine) Sync(ctx context.Context, connID uuid.UUID, mode Mode) error {
	defer e.lock(connID)()
	started := e.o.Now()
	conn, err := e.o.Q.GetGithubConnection(ctx, connID)
	if err != nil {
		if db.IsNotFound(err) {
			return nil // disconnected while queued
		}
		return err
	}
	if err := e.sync(ctx, conn, mode); err != nil {
		if err := e.o.Q.SetGithubConnectionError(ctx, sqlcgen.SetGithubConnectionErrorParams{ID: connID, LastError: ptr(userMessage(err))}); err != nil {
			e.o.Log.Warn("github sync: store error", "connection", connID, "err", err)
		}
		return err
	}
	return e.o.Q.MarkGithubConnectionSynced(ctx, sqlcgen.MarkGithubConnectionSyncedParams{ID: connID, StartedAt: started})
}

func (e *Engine) sync(ctx context.Context, conn sqlcgen.GithubConnection, mode Mode) error {
	r, err := e.newRun(ctx, conn)
	if err != nil {
		return err
	}
	// Pull first: a page that is both dirty and behind is then reconciled once, from fresh data.
	if mode.Pull {
		if err := r.pullIssues(ctx); err != nil {
			return err
		}
		if err := r.pullComments(ctx); err != nil {
			return err
		}
	}
	if mode.Push {
		if err := r.pushNewPages(ctx); err != nil {
			return err
		}
		if err := r.pushDirty(ctx); err != nil {
			return err
		}
		if err := r.pushComments(ctx); err != nil {
			return err
		}
	}
	return nil
}

// userMessage turns an error into the short text shown to admins.
func userMessage(err error) string {
	var api *APIError
	if errors.As(err, &api) {
		switch {
		case api.IsAuth():
			return "GitHub rejected the token. Check that it is valid and has read/write access to the repository's issues."
		case !api.RetryAt.IsZero():
			return "GitHub rate limit reached; the sync resumes automatically."
		case api.Status == 404:
			return "GitHub cannot find the repository, or the token cannot see it."
		}
	}
	msg := err.Error()
	if len(msg) > 400 {
		msg = msg[:400]
	}
	return msg
}

// fatal reports errors that make the rest of the pass pointless.
func fatal(err error) bool {
	var api *APIError
	if errors.As(err, &api) {
		return api.IsAuth() || !api.RetryAt.IsZero() || api.Status >= 500
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// BackoffUntil returns when a failed connection may be retried, or the zero time for "next tick".
func BackoffUntil(err error, now time.Time) time.Time {
	var api *APIError
	if errors.As(err, &api) && !api.RetryAt.IsZero() {
		return api.RetryAt
	}
	return now.Add(2 * time.Minute)
}

// ---------------------------------------------------------------- one pass over one connection

type run struct {
	e      *Engine
	q      *sqlcgen.Queries
	conn   sqlcgen.GithubConnection
	client *Client
	conv   Converter
	root   uuid.UUID
	// failed lists the pages that already errored in this pass.
	failed map[uuid.UUID]bool
}

func (e *Engine) newRun(ctx context.Context, conn sqlcgen.GithubConnection) (*run, error) {
	token, err := e.o.Vault.Open(conn.TokenEnc)
	if err != nil {
		return nil, err
	}
	if _, err := perm.RequireWorkspaceAdmin(ctx, e.o.Q, conn.WorkspaceID, conn.SyncUserID); err != nil {
		return nil, errors.New("the user who connected this repository is no longer an owner or admin of the workspace; reconnect it")
	}
	ws, err := e.o.Q.GetWorkspace(ctx, conn.WorkspaceID)
	if err != nil {
		return nil, fmt.Errorf("load workspace: %w", err)
	}
	numbers, err := e.o.Q.ListGithubLinkNumbers(ctx, conn.ID)
	if err != nil {
		return nil, fmt.Errorf("list links: %w", err)
	}
	issues := make(map[uuid.UUID]int32, len(numbers))
	for _, n := range numbers {
		issues[n.PageID] = n.IssueNumber
	}
	r := &run{
		e: e, q: e.o.Q, conn: conn, client: e.o.NewClient(string(token)), failed: map[uuid.UUID]bool{},
		conv: Converter{PublicURL: e.o.PublicURL, WorkspaceSlug: ws.Slug, Issues: issues},
	}
	if err := r.ensureRoot(ctx); err != nil {
		return nil, err
	}
	return r, nil
}

// ensureRoot makes sure the page that holds the issue pages exists. If it was purged, its children went with it,
// so the cursors are reset and the next pass imports everything again.
func (r *run) ensureRoot(ctx context.Context) error {
	if r.conn.RootPageID != nil {
		p, err := r.q.GetPage(ctx, *r.conn.RootPageID)
		switch {
		case err == nil && p.ArchivedAt != nil:
			return errors.New("the root page of this connection is in the trash; restore it or disconnect the repository")
		case err == nil:
			r.root = p.ID
			return nil
		case !db.IsNotFound(err):
			return err
		}
	}
	icon := iconRoot
	sum, _, err := r.e.o.Pages.Create(ctx, r.conn.SyncUserID, r.conn.WorkspaceID, pages.CreateInput{
		Title: "GitHub: " + r.conn.Owner + "/" + r.conn.Repo, Icon: &icon,
	})
	if err != nil {
		return fmt.Errorf("create root page: %w", err)
	}
	r.root = sum.Id
	if err := r.q.SetGithubConnectionRoot(ctx, sqlcgen.SetGithubConnectionRootParams{ID: r.conn.ID, RootPageID: &r.root}); err != nil {
		return err
	}
	if err := r.q.ResetGithubConnectionCursors(ctx, r.conn.ID); err != nil {
		return err
	}
	r.conn.IssuesSince, r.conn.CommentsSince, r.conn.BackfilledAt = nil, nil, nil
	return nil
}

func stateIcon(state string) string {
	if state == "closed" {
		return iconClosed
	}
	return iconOpen
}

// ownsIcon: the sync only touches icons it set itself, never one a person picked.
func ownsIcon(icon *string) bool {
	return icon == nil || *icon == "" || *icon == iconOpen || *icon == iconClosed
}

func ptr[T any](v T) *T { return &v }

func clip(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

func (r *run) pageMarkdown(ctx context.Context, id uuid.UUID) string {
	c, err := r.q.GetPageContent(ctx, id)
	if err != nil {
		return ""
	}
	return c.Markdown
}

func (r *run) localTitle(title string) string { return clip(normalizeTitle(title), maxIssueTitle) }

func (r *run) publishPage(ctx context.Context, pageID uuid.UUID) {
	if r.e.o.Broker == nil {
		return
	}
	row, err := r.q.GetPage(ctx, pageID)
	if err != nil {
		return
	}
	sum := pages.ToSummary(row, perm.None, true)
	sum.Role = ""
	r.e.o.Broker.Publish(events.Event{Type: events.PageUpdated, WorkspaceID: row.WorkspaceID, PageID: pageID, Page: &sum})
}

// fail records a per-page error and returns it unchanged. Whether it ends the pass (fatal) or only skips the
// item is the caller's decision; the pull loops also use it to hold their cursor back so the item is retried.
// A failed page is left alone for the rest of the pass.
func (r *run) fail(ctx context.Context, pageID uuid.UUID, what string, err error) error {
	if fatal(err) {
		return err
	}
	r.e.o.Log.Warn("github sync: item failed", "connection", r.conn.ID, "page", pageID, "what", what, "err", err)
	if pageID != uuid.Nil {
		r.failed[pageID] = true
		if serr := r.q.SetGithubIssueLinkError(ctx, sqlcgen.SetGithubIssueLinkErrorParams{PageID: pageID, SyncError: ptr(userMessage(err))}); serr == nil {
			r.publishPage(ctx, pageID)
		}
	}
	return err
}

// ---------------------------------------------------------------- GitHub -> Hostidian

func (r *run) pullIssues(ctx context.Context) error {
	since := r.conn.IssuesSince
	var maxSeen time.Time
	var failedAt *time.Time
	for page := 1; ; page++ {
		issues, more, err := r.client.ListIssues(ctx, r.conn.Owner, r.conn.Repo, since, page)
		if err != nil {
			return err
		}
		for _, is := range issues {
			if is.UpdatedAt.After(maxSeen) {
				maxSeen = is.UpdatedAt
			}
			if is.PullRequest != nil {
				continue
			}
			if err := r.pullIssue(ctx, is); err != nil {
				if fatal(err) {
					return err
				}
				if failedAt == nil {
					t := is.UpdatedAt
					failedAt = &t
				}
			}
		}
		if !more {
			break
		}
	}
	// A failed issue holds the cursor back so the next pass retries it.
	cursor := maxSeen
	if failedAt != nil && failedAt.Before(cursor) {
		cursor = *failedAt
	}
	if !cursor.IsZero() {
		if err := r.q.SetGithubConnectionCursors(ctx, sqlcgen.SetGithubConnectionCursorsParams{ID: r.conn.ID, IssuesSince: &cursor}); err != nil {
			return err
		}
	}
	if failedAt == nil && r.conn.BackfilledAt == nil {
		return r.q.MarkGithubBackfilled(ctx, r.conn.ID)
	}
	return nil
}

func (r *run) pullIssue(ctx context.Context, is Issue) error {
	link, err := r.q.GetGithubIssueLinkByNumber(ctx, sqlcgen.GetGithubIssueLinkByNumberParams{ConnectionID: r.conn.ID, IssueNumber: is.Number})
	switch {
	case db.IsNotFound(err):
		return r.importIssue(ctx, is)
	case err != nil:
		return err
	case is.UpdatedAt.Before(link.RemoteUpdatedAt):
		return nil // older than what we already synced: our own echo or a stale page of results
	}
	if err := r.reconcile(ctx, link, is); err != nil {
		return r.fail(ctx, link.PageID, "reconcile", err)
	}
	return nil
}

// importIssue gives an issue we have not seen a page. An issue created from a page of ours whose link was lost
// (crash between the GitHub call and the insert) carries the page marker and is re-linked instead.
func (r *run) importIssue(ctx context.Context, is Issue) error {
	clean, markerPage, hasMarker := StripPageMarker(is.BodyText())
	if hasMarker {
		p, err := r.q.FindUnlinkedPageForGithubAdoption(ctx, sqlcgen.FindUnlinkedPageForGithubAdoptionParams{PageID: markerPage, WorkspaceID: r.conn.WorkspaceID})
		if err == nil {
			return r.adopt(ctx, p, is, clean)
		}
		if !db.IsNotFound(err) {
			return err
		}
	}

	title := r.localTitle(is.Title)
	if title == "" {
		title = fmt.Sprintf("Issue #%d", is.Number)
	}
	icon := stateIcon(is.State)
	// A fixed id makes a retry after a crash land on the same page instead of creating a second one.
	pageID := uuid.NewSHA1(r.conn.ID, []byte(fmt.Sprintf("issue-%d", is.Number)))
	if _, _, err := r.e.o.Pages.Create(ctx, r.conn.SyncUserID, r.conn.WorkspaceID, pages.CreateInput{
		ID: &pageID, ParentID: &r.root, Title: title, Icon: &icon,
	}); err != nil {
		return fmt.Errorf("create page for #%d: %w", is.Number, err)
	}
	page, err := r.q.GetPage(ctx, pageID)
	if err != nil {
		return err
	}
	// The local side starts empty and the remote body counts as not yet transferred, so reconcile pulls it.
	link, err := r.q.InsertGithubIssueLink(ctx, sqlcgen.InsertGithubIssueLinkParams{
		PageID: pageID, ConnectionID: r.conn.ID, IssueNumber: is.Number, HtmlUrl: is.HTMLURL,
		BaseTitle: r.localTitle(page.Title), BaseState: is.State,
		BaseLocalBodyHash: HashBody(r.conv.ToGitHub(r.pageMarkdown(ctx, pageID))), BaseRemoteBodyHash: pendingRemoteBody,
		RemoteUpdatedAt: is.UpdatedAt, SyncedPageUpdatedAt: page.UpdatedAt,
	})
	if err != nil {
		return err
	}
	r.conv.Issues[pageID] = is.Number
	if _, err := r.ensureThread(ctx, link); err != nil {
		return r.fail(ctx, pageID, "thread", err)
	}
	if err := r.reconcile(ctx, link, is); err != nil {
		return r.fail(ctx, pageID, "import body", err)
	}
	return nil
}

func (r *run) adopt(ctx context.Context, p sqlcgen.Page, is Issue, cleanBody string) error {
	link, err := r.q.InsertGithubIssueLink(ctx, sqlcgen.InsertGithubIssueLinkParams{
		PageID: p.ID, ConnectionID: r.conn.ID, IssueNumber: is.Number, HtmlUrl: is.HTMLURL,
		BaseTitle: normalizeTitle(is.Title), BaseState: is.State,
		BaseLocalBodyHash: HashBody(r.conv.ToGitHub(r.pageMarkdown(ctx, p.ID))), BaseRemoteBodyHash: HashBody(cleanBody),
		RemoteUpdatedAt: is.UpdatedAt, SyncedPageUpdatedAt: p.UpdatedAt,
	})
	if err != nil {
		return err
	}
	r.conv.Issues[p.ID] = is.Number
	if _, err := r.ensureThread(ctx, link); err != nil {
		return r.fail(ctx, p.ID, "thread", err)
	}
	if err := r.reconcile(ctx, link, is); err != nil {
		return r.fail(ctx, p.ID, "adopt", err)
	}
	return nil
}

// reconcile brings one linked page and its issue together according to Decide, then re-snapshots both.
func (r *run) reconcile(ctx context.Context, link sqlcgen.GithubIssueLink, is Issue) error {
	page, err := r.q.GetPage(ctx, link.PageID)
	if err != nil {
		return err
	}
	if page.ArchivedAt != nil {
		return nil // in the trash: sync resumes when it is restored
	}
	localBody := r.conv.ToGitHub(r.pageMarkdown(ctx, link.PageID))
	remoteBody, _, _ := StripPageMarker(is.BodyText())

	base := Base{Title: link.BaseTitle, State: link.BaseState, LocalBodyHash: link.BaseLocalBodyHash, RemoteBodyHash: link.BaseRemoteBodyHash}
	local := Side{Title: r.localTitle(page.Title), BodyHash: HashBody(localBody), UpdatedAt: page.UpdatedAt}
	remote := Side{Title: normalizeTitle(is.Title), BodyHash: HashBody(remoteBody), UpdatedAt: is.UpdatedAt}
	plan := Decide(base, local, remote, is.State)

	next := base
	next.Title, next.LocalBodyHash, next.RemoteBodyHash = local.Title, local.BodyHash, remote.BodyHash
	remoteUpdated := is.UpdatedAt
	url := is.HTMLURL
	wroteLocal, wroteRemote := false, false

	// GitHub -> page.
	if plan.Title == Pull {
		t := clip(remote.Title, 500)
		if t == "" {
			t = fmt.Sprintf("Issue #%d", is.Number)
		}
		if _, err := r.e.o.Pages.Update(ctx, r.conn.SyncUserID, link.PageID, pages.UpdateInput{Title: &t}); err != nil {
			return fmt.Errorf("update title: %w", err)
		}
		next.Title, wroteLocal = r.localTitle(t), true
	}
	if plan.Body == Pull {
		md, err := r.e.o.Collab.ApplyMarkdown(ctx, collabclient.ApplyRequest{
			PageID: link.PageID, Markdown: r.conv.FromGitHub(is.BodyText()), Mode: collabclient.ApplyReplace, EditorID: r.conn.SyncUserID,
		})
		if err != nil {
			return fmt.Errorf("copy body into page: %w", err)
		}
		next.LocalBodyHash, wroteLocal = HashBody(r.conv.ToGitHub(md)), true
	}
	if plan.State == Pull && ownsIcon(page.Icon) {
		icon := stateIcon(is.State)
		if _, err := r.e.o.Pages.Update(ctx, r.conn.SyncUserID, link.PageID, pages.UpdateInput{SetIcon: true, Icon: &icon}); err != nil {
			return fmt.Errorf("update icon: %w", err)
		}
		wroteLocal = true
	}
	next.State = is.State

	// page -> GitHub.
	var patch IssuePatch
	if plan.Title == Push {
		patch.Title = &local.Title
	}
	if plan.Body == Push {
		patch.Body = &localBody
	}
	if patch.Title != nil || patch.Body != nil {
		out, err := r.client.PatchIssue(ctx, r.conn.Owner, r.conn.Repo, is.Number, patch)
		if err != nil {
			return err
		}
		wroteRemote = true
		remoteUpdated, url, next.State = out.UpdatedAt, out.HTMLURL, out.State
		if patch.Title != nil {
			next.Title = normalizeTitle(out.Title)
		}
		if patch.Body != nil {
			sent, _, _ := StripPageMarker(out.BodyText())
			next.RemoteBodyHash, next.LocalBodyHash = HashBody(sent), local.BodyHash
		}
	}

	stamp := page.UpdatedAt
	if wroteLocal {
		// Our own writes bumped updated_at; they are part of the snapshot, not a pending edit.
		if p, err := r.q.GetPage(ctx, link.PageID); err == nil {
			stamp = p.UpdatedAt
		}
	}
	if err := r.q.UpdateGithubIssueLinkSynced(ctx, sqlcgen.UpdateGithubIssueLinkSyncedParams{
		PageID: link.PageID, BaseTitle: next.Title, BaseState: next.State,
		BaseLocalBodyHash: next.LocalBodyHash, BaseRemoteBodyHash: next.RemoteBodyHash,
		RemoteUpdatedAt: remoteUpdated, SyncedPageUpdatedAt: stamp, HtmlUrl: url,
	}); err != nil {
		return err
	}
	if wroteRemote || link.SyncError != nil {
		r.publishPage(ctx, link.PageID)
	}
	return nil
}

// ---------------------------------------------------------------- comments

func (r *run) ensureThread(ctx context.Context, link sqlcgen.GithubIssueLink) (uuid.UUID, error) {
	if link.CommentThreadID != nil {
		return *link.CommentThreadID, nil
	}
	intro := fmt.Sprintf("Linked to [%s/%s#%d](%s). Comments in this thread are shared with the GitHub issue: replies you write here are posted there.",
		r.conn.Owner, r.conn.Repo, link.IssueNumber, link.HtmlUrl)
	th, err := r.e.o.Comments.Create(ctx, r.conn.SyncUserID, link.PageID, comments.CreateThreadInput{
		BlockID: ThreadBlockID, Quote: fmt.Sprintf("GitHub issue #%d", link.IssueNumber), Body: intro,
	})
	if err != nil {
		return uuid.Nil, fmt.Errorf("create comment thread: %w", err)
	}
	if len(th.Comments) > 0 {
		if err := r.q.InsertGithubCommentLink(ctx, sqlcgen.InsertGithubCommentLinkParams{
			CommentID: th.Comments[0].Id, ConnectionID: r.conn.ID, Origin: "system",
		}); err != nil {
			return uuid.Nil, err
		}
	}
	if err := r.q.SetGithubIssueLinkThread(ctx, sqlcgen.SetGithubIssueLinkThreadParams{PageID: link.PageID, CommentThreadID: &th.Id}); err != nil {
		return uuid.Nil, err
	}
	return th.Id, nil
}

func (r *run) pullComments(ctx context.Context) error {
	since := r.conn.CommentsSince
	var maxSeen time.Time
	var failedAt *time.Time
	for page := 1; ; page++ {
		batch, more, err := r.client.ListComments(ctx, r.conn.Owner, r.conn.Repo, since, page)
		if err != nil {
			return err
		}
		for _, c := range batch {
			if c.UpdatedAt.After(maxSeen) {
				maxSeen = c.UpdatedAt
			}
			if err := r.pullComment(ctx, c); err != nil {
				if fatal(err) {
					return err
				}
				r.e.o.Log.Warn("github sync: comment failed", "connection", r.conn.ID, "comment", c.ID, "err", err)
				if failedAt == nil {
					t := c.UpdatedAt
					failedAt = &t
				}
			}
		}
		if !more {
			break
		}
	}
	cursor := maxSeen
	if failedAt != nil && failedAt.Before(cursor) {
		cursor = *failedAt
	}
	if cursor.IsZero() {
		return nil
	}
	return r.q.SetGithubConnectionCursors(ctx, sqlcgen.SetGithubConnectionCursorsParams{ID: r.conn.ID, CommentsSince: &cursor})
}

func (r *run) pullComment(ctx context.Context, c Comment) error {
	number, ok := c.IssueNumber()
	if !ok {
		return nil
	}
	link, err := r.q.GetGithubIssueLinkByNumber(ctx, sqlcgen.GetGithubIssueLinkByNumberParams{ConnectionID: r.conn.ID, IssueNumber: number})
	if db.IsNotFound(err) {
		return nil // a comment on an issue that is not synced (a pull request, or imported later)
	}
	if err != nil {
		return err
	}

	existing, err := r.q.GetGithubCommentLinkByRemote(ctx, sqlcgen.GetGithubCommentLinkByRemoteParams{ConnectionID: r.conn.ID, GithubCommentID: &c.ID})
	switch {
	case err == nil:
		return r.refreshComment(ctx, existing, c)
	case !db.IsNotFound(err):
		return err
	}

	// Posted from Hostidian, but the link was never stored: re-link instead of mirroring it back.
	if id, ok := ParseCommentMarker(c.Body); ok {
		if _, err := r.q.GetComment(ctx, id); err == nil {
			return r.q.InsertGithubCommentLink(ctx, sqlcgen.InsertGithubCommentLinkParams{
				CommentID: id, ConnectionID: r.conn.ID, GithubCommentID: &c.ID, Origin: "hostidian",
				RemoteUpdatedAt: &c.UpdatedAt, BodyHash: HashBody(c.Body),
			})
		}
	}

	threadID, err := r.ensureThread(ctx, link)
	if err != nil {
		return err
	}
	posted, err := r.e.o.Comments.Reply(ctx, r.conn.SyncUserID, threadID, r.incomingText(c))
	if err != nil {
		return fmt.Errorf("mirror comment: %w", err)
	}
	return r.q.InsertGithubCommentLink(ctx, sqlcgen.InsertGithubCommentLinkParams{
		CommentID: posted.Id, ConnectionID: r.conn.ID, GithubCommentID: &c.ID, Origin: "github",
		RemoteUpdatedAt: &c.UpdatedAt, BodyHash: HashBody(c.Body),
	})
}

func (r *run) incomingText(c Comment) string {
	text := FormatIncomingComment(c.User.Login, c.Body)
	if utf8.RuneCountInString(text) > maxCommentText {
		text = clip(text, maxCommentText) + "\n\n… (truncated, see the full comment on GitHub)"
	}
	return text
}

// refreshComment applies a GitHub-side edit to the mirrored comment. Edits made in Hostidian are not sent back.
func (r *run) refreshComment(ctx context.Context, link sqlcgen.GithubCommentLink, c Comment) error {
	hash := HashBody(c.Body)
	if link.Origin != "github" || hash == link.BodyHash {
		return nil
	}
	if _, err := r.e.o.Comments.Update(ctx, r.conn.SyncUserID, link.CommentID, r.incomingText(c)); err != nil {
		return fmt.Errorf("update mirrored comment: %w", err)
	}
	return r.q.UpdateGithubCommentLink(ctx, sqlcgen.UpdateGithubCommentLinkParams{CommentID: link.CommentID, RemoteUpdatedAt: &c.UpdatedAt, BodyHash: hash})
}

// ---------------------------------------------------------------- Hostidian -> GitHub

func (r *run) settledBefore(d time.Duration) time.Time { return r.e.o.Now().Add(-d) }

func (r *run) pushDirty(ctx context.Context) error {
	links, err := r.q.ListDirtyGithubLinks(ctx, sqlcgen.ListDirtyGithubLinksParams{
		ConnectionID: r.conn.ID, SettledBefore: r.settledBefore(r.e.o.Settle), MaxRows: batchSize,
	})
	if err != nil {
		return err
	}
	for _, link := range links {
		if r.failed[link.PageID] {
			continue // already failed earlier in this pass; retry on the next one
		}
		is, err := r.client.GetIssue(ctx, r.conn.Owner, r.conn.Repo, link.IssueNumber)
		if err == nil {
			err = r.reconcile(ctx, link, is)
		}
		if err != nil && fatal(r.fail(ctx, link.PageID, "push", err)) {
			return err
		}
	}
	return nil
}

// pushNewPages opens an issue for every page created under the root page by hand.
func (r *run) pushNewPages(ctx context.Context) error {
	rows, err := r.q.ListNewGithubChildPages(ctx, sqlcgen.ListNewGithubChildPagesParams{
		RootPageID: &r.root, SettledBefore: r.settledBefore(r.e.o.NewPageSettle), MaxRows: batchSize,
	})
	if err != nil {
		return err
	}
	for _, p := range rows {
		if err := r.createIssue(ctx, p); err != nil && fatal(r.fail(ctx, uuid.Nil, "create issue", err)) {
			return err
		}
	}
	return nil
}

func (r *run) createIssue(ctx context.Context, p sqlcgen.Page) error {
	body := r.conv.ToGitHub(r.pageMarkdown(ctx, p.ID))
	sent := body
	if sent != "" {
		sent += "\n\n"
	}
	is, err := r.client.CreateIssue(ctx, r.conn.Owner, r.conn.Repo, r.localTitle(p.Title), sent+PageMarker(p.ID))
	if err != nil {
		return err
	}
	if ownsIcon(p.Icon) {
		icon := stateIcon(is.State)
		if _, err := r.e.o.Pages.Update(ctx, r.conn.SyncUserID, p.ID, pages.UpdateInput{SetIcon: true, Icon: &icon}); err != nil {
			return fmt.Errorf("update icon: %w", err)
		}
	}
	page, err := r.q.GetPage(ctx, p.ID)
	if err != nil {
		return err
	}
	remoteBody, _, _ := StripPageMarker(is.BodyText())
	link, err := r.q.InsertGithubIssueLink(ctx, sqlcgen.InsertGithubIssueLinkParams{
		PageID: p.ID, ConnectionID: r.conn.ID, IssueNumber: is.Number, HtmlUrl: is.HTMLURL,
		BaseTitle: normalizeTitle(is.Title), BaseState: is.State,
		BaseLocalBodyHash: HashBody(body), BaseRemoteBodyHash: HashBody(remoteBody),
		RemoteUpdatedAt: is.UpdatedAt, SyncedPageUpdatedAt: page.UpdatedAt,
	})
	if err != nil {
		return err
	}
	r.conv.Issues[p.ID] = is.Number
	if _, err := r.ensureThread(ctx, link); err != nil {
		return err
	}
	r.publishPage(ctx, p.ID)
	return nil
}

func (r *run) pushComments(ctx context.Context) error {
	rows, err := r.q.ListUnpushedGithubComments(ctx, sqlcgen.ListUnpushedGithubCommentsParams{ConnectionID: r.conn.ID, MaxRows: batchSize})
	if err != nil {
		return err
	}
	for _, c := range rows {
		out, err := r.client.CreateComment(ctx, r.conn.Owner, r.conn.Repo, c.IssueNumber, FormatOutgoingComment(c.Body, c.AuthorName, c.CommentID))
		if err != nil {
			if fatal(r.fail(ctx, c.PageID, "post comment", err)) {
				return err
			}
			continue
		}
		if err := r.q.InsertGithubCommentLink(ctx, sqlcgen.InsertGithubCommentLinkParams{
			CommentID: c.CommentID, ConnectionID: r.conn.ID, GithubCommentID: &out.ID, Origin: "hostidian",
			RemoteUpdatedAt: &out.UpdatedAt, BodyHash: HashBody(out.Body),
		}); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- actions outside a pass

// SetIssueState closes or reopens the issue behind a page and records the new state as agreed.
func (e *Engine) SetIssueState(ctx context.Context, userID, pageID uuid.UUID, state string) error {
	if state != "open" && state != "closed" {
		return fmt.Errorf("invalid state %q", state)
	}
	acc, err := perm.Require(ctx, e.o.Q, userID, pageID, perm.Edit)
	if err != nil {
		return err
	}
	link, err := e.o.Q.GetGithubIssueLinkByPage(ctx, pageID)
	if err != nil {
		return err
	}
	unlock, err := e.lockWithin(ctx, link.ConnectionID)
	if err != nil {
		return err
	}
	defer unlock()
	conn, err := e.o.Q.GetGithubConnection(ctx, link.ConnectionID)
	if err != nil {
		return err
	}
	if conn.WorkspaceID != acc.WorkspaceID {
		return perm.ErrPageNotFound
	}
	r, err := e.newRun(ctx, conn)
	if err != nil {
		return err
	}
	// Re-read inside the lock: a pass may have re-snapshotted the link meanwhile.
	link, err = e.o.Q.GetGithubIssueLinkByPage(ctx, pageID)
	if err != nil {
		return err
	}
	out, err := r.client.PatchIssue(ctx, conn.Owner, conn.Repo, link.IssueNumber, IssuePatch{State: &state})
	if err != nil {
		return err
	}
	// Only the state fields move; title/body keep their old snapshot so a pending edit is still pushed.
	if err := e.o.Q.SetGithubIssueLinkState(ctx, sqlcgen.SetGithubIssueLinkStateParams{
		PageID: pageID, BaseState: out.State, RemoteUpdatedAt: out.UpdatedAt,
	}); err != nil {
		return err
	}
	page, err := e.o.Q.GetPage(ctx, pageID)
	if err == nil && ownsIcon(page.Icon) {
		icon := stateIcon(out.State)
		_, err = e.o.Pages.Update(ctx, userID, pageID, pages.UpdateInput{SetIcon: true, Icon: &icon})
	}
	r.publishPage(ctx, pageID)
	return err
}

// DeleteMirroredComment removes the Hostidian copy of a comment deleted on GitHub (webhook).
func (e *Engine) DeleteMirroredComment(ctx context.Context, connID uuid.UUID, githubCommentID int64) error {
	defer e.lock(connID)()
	conn, err := e.o.Q.GetGithubConnection(ctx, connID)
	if err != nil {
		return err
	}
	gone, err := e.o.Q.DeleteGithubCommentLinkByRemote(ctx, sqlcgen.DeleteGithubCommentLinkByRemoteParams{ConnectionID: connID, GithubCommentID: &githubCommentID})
	if err != nil {
		if db.IsNotFound(err) {
			return nil
		}
		return err
	}
	if err := e.o.Comments.Delete(ctx, conn.SyncUserID, gone.CommentID); err != nil {
		if ae, ok := apperr.As(err); ok && ae.Status == http.StatusNotFound {
			return nil // already gone
		}
		return err
	}
	return nil
}
