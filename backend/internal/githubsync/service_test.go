package githubsync

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db/sqlcgen"
)

// service returns a Service over the scenario's engine with no connection yet registered by Connect.
func (s *scenario) service() *Service {
	svc := NewService(s.engine)
	svc.pollEvery = time.Hour
	return svc
}

func status(err error) int {
	if ae, ok := apperr.As(err); ok {
		return ae.Status
	}
	return 0
}

func TestConnectValidatesAndNeverStoresThePlainToken(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	s.f.Member("member", "member")
	member := s.f.Users["member"]

	if _, err := svc.Connect(ctx, member, s.f.WS, "acme/site", "ghp_x"); status(err) != http.StatusForbidden {
		t.Fatalf("a plain member connected a repository: %v", err)
	}
	for _, bad := range []string{"", "acme", "../site", "https://evil.example/acme/site"} {
		if _, err := svc.Connect(ctx, s.owner, s.f.WS, bad, "ghp_x"); status(err) != http.StatusUnprocessableEntity {
			t.Fatalf("repository %q: %v", bad, err)
		}
	}
	for _, bad := range []string{"", "has space", strings.Repeat("a", 300)} {
		if _, err := svc.Connect(ctx, s.owner, s.f.WS, "acme/site", bad); status(err) != http.StatusUnprocessableEntity {
			t.Fatalf("token %q: %v", bad, err)
		}
	}
	s.gh.fail["get repo"] = 401
	if _, err := svc.Connect(ctx, s.owner, s.f.WS, "acme/site", "ghp_x"); status(err) != http.StatusUnprocessableEntity {
		t.Fatalf("rejected token: %v", err)
	}
	if _, err := svc.Connect(ctx, s.owner, s.f.WS, "acme/other", "ghp_x"); status(err) != http.StatusUnprocessableEntity {
		t.Fatalf("unknown repository: %v", err)
	}
	s.gh.issuesDisabled = true
	if _, err := svc.Connect(ctx, s.owner, s.f.WS, "acme/site", "ghp_x"); status(err) != http.StatusUnprocessableEntity {
		t.Fatalf("issues disabled: %v", err)
	}
	s.gh.issuesDisabled = false

	// s.conn already occupies acme/site in this workspace.
	if _, err := svc.Connect(ctx, s.owner, s.f.WS, "https://github.com/ACME/Site", "ghp_x"); status(err) != http.StatusConflict {
		t.Fatalf("duplicate connection: %v", err)
	}
	s.f.Exec(`DELETE FROM github_connections`)

	info, err := svc.Connect(ctx, s.owner, s.f.WS, "acme/site", "ghp_secret_token")
	if err != nil {
		t.Fatal(err)
	}
	if info.Repository != "acme/site" || len(info.WebhookSecret) != 64 || info.WebhookURL != "https://notes.example.com"+WebhookPath+info.ID.String() {
		t.Fatalf("info = %+v", info)
	}
	var stored []byte
	var secretStored []byte
	if err := s.f.Pool.QueryRow(ctx, `SELECT token_enc, webhook_secret_enc FROM github_connections WHERE id = $1`, info.ID).Scan(&stored, &secretStored); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("ghp_secret_token")) || bytes.Contains(secretStored, []byte(info.WebhookSecret)) {
		t.Fatal("a secret is stored in plain text")
	}

	if _, err := svc.List(ctx, member, s.f.WS); status(err) != http.StatusForbidden {
		t.Fatalf("a member listed connections: %v", err)
	}
	list, err := svc.List(ctx, s.owner, s.f.WS)
	if err != nil || len(list) != 1 || list[0].WebhookSecret != info.WebhookSecret {
		t.Fatalf("list = %+v, %v", list, err)
	}
}

func TestConnectionsOfOtherWorkspacesAreInvisible(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	other := s.f.User("outsider") // not a member of the main workspace
	for name, call := range map[string]func() error{
		"update": func() error { _, err := svc.Update(ctx, other, s.conn.ID, nil, nil); return err },
		"delete": func() error { return svc.Delete(ctx, other, s.conn.ID) },
		"sync":   func() error { return svc.SyncNow(ctx, other, s.conn.ID) },
	} {
		if got := status(call()); got != http.StatusNotFound {
			t.Errorf("%s by an outsider = %d, want 404", name, got)
		}
	}
	if _, err := svc.Update(ctx, s.f.Member("member", "member"), s.conn.ID, nil, nil); status(err) != http.StatusNotFound {
		t.Errorf("update by a member: %v", err)
	}
}

func TestUpdatePausesAndReplacingTheTokenTakesOverAttribution(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	admin := s.f.Member("admin2", "admin")

	off := false
	info, err := svc.Update(ctx, s.owner, s.conn.ID, &off, nil)
	if err != nil || info.Enabled {
		t.Fatalf("pause: %+v %v", info, err)
	}
	tok := "ghp_new_token"
	info, err = svc.Update(ctx, admin, s.conn.ID, nil, &tok)
	if err != nil || info.SyncUserID != admin {
		t.Fatalf("token replace: %+v %v", info, err)
	}
	s.gh.fail["get repo"] = 401
	bad := "ghp_bad"
	if _, err := svc.Update(ctx, admin, s.conn.ID, nil, &bad); status(err) != http.StatusUnprocessableEntity {
		t.Fatalf("bad replacement token: %v", err)
	}
}

func TestDisconnectKeepsPagesAndDropsLinks(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)
	if err := s.service().Delete(context.Background(), s.owner, s.conn.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.f.Q.GetPage(context.Background(), p.ID); err != nil {
		t.Fatalf("the page was deleted with the connection: %v", err)
	}
	link, err := s.service().PageLink(context.Background(), p.ID)
	if err != nil || link != nil {
		t.Fatalf("link survived: %+v %v", link, err)
	}
}

func TestWebhookAuthenticationAndRouting(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	body := []byte(`{"action":"edited","repository":{"full_name":"acme/site"}}`)
	requested := func() bool {
		c, _ := s.f.Q.GetGithubConnection(ctx, s.conn.ID)
		return c.SyncRequestedAt != nil
	}

	if err := svc.HandleWebhook(ctx, s.conn.ID, "issues", Sign("wrong", body), body); !errors.Is(err, ErrBadSignature) || requested() {
		t.Fatalf("bad signature: err=%v requested=%v", err, requested())
	}
	if err := svc.HandleWebhook(ctx, s.conn.ID, "issues", "", body); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("missing signature: %v", err)
	}
	if err := svc.HandleWebhook(ctx, uuid.New(), "issues", Sign("whsec", body), body); !errors.Is(err, ErrUnknownConnection) {
		t.Fatalf("unknown connection: %v", err)
	}
	// Tampered body under a valid signature of the original.
	if err := svc.HandleWebhook(ctx, s.conn.ID, "issues", Sign("whsec", body), append(body[:len(body)-1:len(body)-1], ' ', '}')); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("tampered body: %v", err)
	}
	if err := svc.HandleWebhook(ctx, s.conn.ID, "ping", Sign("whsec", body), body); err != nil || requested() {
		t.Fatalf("ping: err=%v requested=%v", err, requested())
	}
	other := []byte(`{"action":"edited","repository":{"full_name":"someone/else"}}`)
	if err := svc.HandleWebhook(ctx, s.conn.ID, "issues", Sign("whsec", other), other); err != nil || requested() {
		t.Fatalf("other repository: err=%v requested=%v", err, requested())
	}
	if err := svc.HandleWebhook(ctx, s.conn.ID, "issues", Sign("whsec", body), body); err != nil || !requested() {
		t.Fatalf("valid delivery: err=%v requested=%v", err, requested())
	}
	select {
	case <-svc.wake:
	default:
		t.Fatal("the worker was not woken")
	}
}

func TestWebhookCommentDeletionRemovesTheMirror(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	s.gh.addIssue("Fix login", "body")
	c := s.gh.comment(1, "octocat", "to be removed")
	s.both()
	_, link := s.pageFor(1)
	if len(s.thread(link)) != 2 {
		t.Fatal("setup: comment not mirrored")
	}
	body := []byte(`{"action":"deleted","comment":{"id":` + strconv.FormatInt(c.ID, 10) + `},"repository":{"full_name":"acme/site"}}`)
	if err := svc.HandleWebhook(context.Background(), s.conn.ID, "issue_comment", Sign("whsec", body), body); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(s.thread(link)) != 1 {
		if time.Now().After(deadline) {
			t.Fatal("mirrored comment was not removed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestIssueIndexOnlyListsPagesTheUserCanSee(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	s.gh.addIssue("Fix login", "body")
	s.both()
	guest := s.f.Member("guest", "guest")
	member := s.f.Member("member", "member")

	refs, err := svc.Index(ctx, member, s.f.WS)
	if err != nil || len(refs) != 1 || refs[0].Number != 1 || refs[0].Repository != "acme/site" {
		t.Fatalf("member index = %+v, %v", refs, err)
	}
	if refs, err := svc.Index(ctx, guest, s.f.WS); err != nil || len(refs) != 0 {
		t.Fatalf("a guest without access sees %+v, %v", refs, err)
	}
	if _, err := svc.Index(ctx, s.f.User("outsider"), s.f.WS); status(err) != http.StatusNotFound {
		t.Fatalf("outsider: %v", err)
	}
}

func TestSetStateNeedsEditPermissionAndALink(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)
	guest := s.f.Member("guest", "guest")
	if _, err := svc.SetState(ctx, guest, p.ID, "closed"); status(err) != http.StatusNotFound {
		t.Fatalf("guest: %v", err)
	}
	if _, err := svc.SetState(ctx, s.owner, p.ID, "bogus"); status(err) != http.StatusUnprocessableEntity {
		t.Fatalf("bad state: %v", err)
	}
	plain := s.f.Page("Plain", "", "workspace", "owner")
	if _, err := svc.SetState(ctx, s.owner, plain, "closed"); status(err) != http.StatusNotFound {
		t.Fatalf("unlinked page: %v", err)
	}
	link, err := svc.SetState(ctx, s.owner, p.ID, "closed")
	if err != nil || link.State != "closed" || link.Number != 1 || link.Repository != "acme/site" {
		t.Fatalf("link = %+v, %v", link, err)
	}
}

func TestPageLinkReportsSyncErrors(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)
	s.editLocal(p.ID, str("New title"), nil)
	s.gh.fail["patch issue"] = 422
	s.both()
	link, err := svc.PageLink(context.Background(), p.ID)
	if err != nil || link.Error == nil || link.LastSyncedAt.IsZero() {
		t.Fatalf("link = %+v, %v", link, err)
	}
}

func TestWorkerPullsWhenDueAndPushesWhenThereIsLocalWork(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	state := map[uuid.UUID]*connState{}
	s.gh.addIssue("Fix login", "body")

	svc.pass(ctx, state) // first pass: backfill
	if _, err := s.f.Q.GetGithubIssueLinkByNumber(ctx, linkKey(s, 1)); err != nil {
		t.Fatalf("first pass did not import: %v", err)
	}
	lists := s.gh.count("list issues")

	svc.pass(ctx, state) // nothing due, nothing local: no traffic
	if s.gh.count("list issues") != lists {
		t.Fatal("polled again before the interval")
	}

	p, _ := s.pageFor(1)
	s.editLocal(p.ID, str("New title"), nil)
	svc.pass(ctx, state) // local work: push-only pass
	if s.gh.get(1).Title != "New title" {
		t.Fatal("local edit not pushed")
	}
	if s.gh.count("list issues") != lists {
		t.Fatal("a push-only pass polled GitHub")
	}

	if err := svc.SyncNow(ctx, s.owner, s.conn.ID); err != nil {
		t.Fatal(err)
	}
	s.gh.edit(1, func(i *ghIssue) { i.Body = "from github" })
	svc.pass(ctx, state) // requested: pull
	if got := s.markdown(p.ID); got != "from github" {
		t.Fatalf("requested pull did not run: %q", got)
	}
	if c, _ := s.f.Q.GetGithubConnection(ctx, s.conn.ID); c.SyncRequestedAt != nil {
		t.Fatal("request not cleared after the pass")
	}
}

func TestWorkerBacksOffAfterAFailure(t *testing.T) {
	s := newScenario(t)
	svc := s.service()
	ctx := context.Background()
	state := map[uuid.UUID]*connState{}
	s.gh.fail["list issues"] = 401
	svc.pass(ctx, state)
	calls := s.gh.count("list issues")
	svc.pass(ctx, state)
	svc.pass(ctx, state)
	if s.gh.count("list issues") != calls {
		t.Fatal("retried immediately instead of backing off")
	}
	if st := state[s.conn.ID]; st == nil || !st.notBefore.After(time.Now()) {
		t.Fatalf("no back-off recorded: %+v", st)
	}
}

func linkKey(s *scenario, n int32) sqlcgen.GetGithubIssueLinkByNumberParams {
	return sqlcgen.GetGithubIssueLinkByNumberParams{ConnectionID: s.conn.ID, IssueNumber: n}
}

func TestClosingAnIssueDoesNotHangBehindARunningSync(t *testing.T) {
	s := newScenario(t)
	s.engine.o.LockWait = 50 * time.Millisecond
	svc := s.service()
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)

	unlock := s.engine.lock(s.conn.ID) // a long pass is in progress
	start := time.Now()
	_, err := svc.SetState(context.Background(), s.owner, p.ID, "closed")
	unlock()
	if status(err) != http.StatusConflict || time.Since(start) > 5*time.Second {
		t.Fatalf("err=%v after %v", err, time.Since(start))
	}
	if s.gh.get(1).State != "open" {
		t.Fatal("the issue was changed although the request failed")
	}
	if _, err := svc.SetState(context.Background(), s.owner, p.ID, "closed"); err != nil {
		t.Fatalf("after the pass ended: %v", err)
	}
}

func TestDisconnectDoesNotWaitForARunningSync(t *testing.T) {
	s := newScenario(t)
	unlock := s.engine.lock(s.conn.ID)
	defer unlock()
	done := make(chan error, 1)
	go func() { done <- s.service().Delete(context.Background(), s.owner, s.conn.ID) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Delete is blocked behind the sync lock")
	}
}
