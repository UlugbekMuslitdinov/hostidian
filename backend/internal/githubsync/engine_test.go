package githubsync

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/pages"
)

func (s *scenario) rootID() string {
	s.t.Helper()
	c, err := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	if err != nil || c.RootPageID == nil {
		s.t.Fatalf("connection has no root page yet: %v", err)
	}
	return c.RootPageID.String()
}

func (s *scenario) childCount() int {
	s.t.Helper()
	var n int
	if err := s.f.Pool.QueryRow(context.Background(), `SELECT count(*) FROM pages WHERE parent_id = $1`, s.rootID()).Scan(&n); err != nil {
		s.t.Fatal(err)
	}
	return n
}

func TestBackfillImportsIssuesOnceAndSkipsPullRequests(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "Users cannot log in.")
	s.gh.addIssue("Old bug", "")
	s.gh.edit(2, func(i *ghIssue) { i.State = "closed" })
	s.gh.addIssue("A pull request", "diff")
	s.gh.edit(3, func(i *ghIssue) { i.PR = true })

	s.both()

	p1, l1 := s.pageFor(1)
	if p1.Title != "Fix login" || p1.Icon == nil || *p1.Icon != iconOpen {
		t.Fatalf("page 1 = %q icon %v", p1.Title, p1.Icon)
	}
	if got := s.markdown(p1.ID); got != "Users cannot log in." {
		t.Fatalf("body = %q", got)
	}
	if l1.CommentThreadID == nil {
		t.Fatal("synced page has no GitHub thread")
	}
	p2, _ := s.pageFor(2)
	if *p2.Icon != iconClosed {
		t.Fatalf("closed issue icon = %q", *p2.Icon)
	}
	if _, err := s.f.Q.GetGithubIssueLinkByNumber(context.Background(), sqlcgen.GetGithubIssueLinkByNumberParams{ConnectionID: s.conn.ID, IssueNumber: 3}); err == nil {
		t.Fatal("a pull request was imported as an issue")
	}
	if n := s.childCount(); n != 2 {
		t.Fatalf("%d pages under the root, want 2", n)
	}
	c, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	if c.BackfilledAt == nil || c.LastSyncedAt == nil || c.LastError != nil {
		t.Fatalf("connection state after backfill: %+v", c)
	}

	// Running everything again changes nothing: idempotent backfill, no echo.
	applied := s.app.count()
	s.both()
	s.both()
	if n := s.childCount(); n != 2 {
		t.Fatalf("second pass created pages: %d", n)
	}
	if s.gh.count("patch issue") != 0 || s.gh.count("create issue") != 0 || s.app.count() != applied {
		t.Fatalf("second pass wrote: patch=%d create=%d applied %d->%d", s.gh.count("patch issue"), s.gh.count("create issue"), applied, s.app.count())
	}
}

func TestBackfillIsKeyedByIssueNumber(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("One", "a")
	s.both()
	// A second, independent pass from scratch (cursors lost) must reuse the page, not add another.
	if err := s.f.Q.ResetGithubConnectionCursors(context.Background(), s.conn.ID); err != nil {
		t.Fatal(err)
	}
	s.both()
	if n := s.childCount(); n != 1 {
		t.Fatalf("re-backfill produced %d pages", n)
	}
}

func TestLocalEditIsPushedOnceAndNeverEchoes(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "old body")
	s.both()
	p, _ := s.pageFor(1)
	applied := s.app.count()

	s.editLocal(p.ID, str("Fix login redirect"), str("new **body**"))
	s.both()

	is := s.gh.get(1)
	if is.Title != "Fix login redirect" || is.Body != "new **body**" {
		t.Fatalf("GitHub has %q / %q", is.Title, is.Body)
	}
	if n := s.gh.count("patch issue"); n != 1 {
		t.Fatalf("%d PATCH calls, want 1", n)
	}
	// The write bumped updated_at on GitHub; the next passes must recognise it as our own.
	s.both()
	s.both()
	if n := s.gh.count("patch issue"); n != 1 {
		t.Fatalf("echo: %d PATCH calls after re-sync", n)
	}
	if s.app.count() != applied {
		t.Fatal("our own push was pulled back into the page")
	}
}

func TestRemoteEditIsPulledWithoutPushingBack(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "old body")
	s.both()
	p, _ := s.pageFor(1)

	s.gh.edit(1, func(i *ghIssue) { i.Title = "Fix login (urgent)"; i.Body = "fresh body" })
	s.both()
	s.both()

	got, _ := s.f.Q.GetPage(context.Background(), p.ID)
	if got.Title != "Fix login (urgent)" || s.markdown(p.ID) != "fresh body" {
		t.Fatalf("page = %q / %q", got.Title, s.markdown(p.ID))
	}
	if s.gh.count("patch issue") != 0 {
		t.Fatal("a pulled change was pushed back")
	}
}

func TestEditorMarkdownNormalisationDoesNotPingPong(t *testing.T) {
	s := newScenario(t)
	s.app.normalize = func(md string) string { return strings.ReplaceAll(md, "* ", "- ") }
	s.gh.addIssue("Tasks", "* a\n* b")
	s.both()
	p, _ := s.pageFor(1)
	if s.markdown(p.ID) != "- a\n- b" {
		t.Fatalf("page body = %q", s.markdown(p.ID))
	}
	for i := 0; i < 3; i++ {
		s.both()
	}
	if s.gh.count("patch issue") != 0 {
		t.Fatalf("normalisation bounced back to GitHub (%d PATCH)", s.gh.count("patch issue"))
	}
}

func TestConflictsGoToTheSideEditedLast(t *testing.T) {
	t.Run("GitHub newer", func(t *testing.T) {
		s := newScenario(t)
		s.gh.addIssue("Original", "")
		s.both()
		p, _ := s.pageFor(1)
		s.editLocal(p.ID, str("Local title"), nil)
		s.gh.clock = time.Now().Add(time.Hour)
		s.gh.edit(1, func(i *ghIssue) { i.Title = "Remote title" })
		s.both()
		got, _ := s.f.Q.GetPage(context.Background(), p.ID)
		if got.Title != "Remote title" || s.gh.get(1).Title != "Remote title" {
			t.Fatalf("page %q, GitHub %q", got.Title, s.gh.get(1).Title)
		}
	})
	t.Run("Hostidian newer", func(t *testing.T) {
		s := newScenario(t)
		s.gh.addIssue("Original", "")
		s.both()
		p, _ := s.pageFor(1)
		s.gh.edit(1, func(i *ghIssue) { i.Title = "Remote title" })
		s.editLocal(p.ID, str("Local title"), nil)
		s.both()
		got, _ := s.f.Q.GetPage(context.Background(), p.ID)
		if got.Title != "Local title" || s.gh.get(1).Title != "Local title" {
			t.Fatalf("page %q, GitHub %q", got.Title, s.gh.get(1).Title)
		}
	})
	t.Run("different fields never conflict", func(t *testing.T) {
		s := newScenario(t)
		s.gh.addIssue("Original", "body")
		s.both()
		p, _ := s.pageFor(1)
		s.editLocal(p.ID, str("Local title"), nil)
		s.gh.edit(1, func(i *ghIssue) { i.Body = "remote body" })
		s.both()
		got, _ := s.f.Q.GetPage(context.Background(), p.ID)
		if got.Title != "Local title" || s.markdown(p.ID) != "remote body" {
			t.Fatalf("page %q / %q", got.Title, s.markdown(p.ID))
		}
		if is := s.gh.get(1); is.Title != "Local title" || is.Body != "remote body" {
			t.Fatalf("GitHub %q / %q", is.Title, is.Body)
		}
	})
}

func TestNewPageUnderRootOpensAnIssue(t *testing.T) {
	s := newScenario(t)
	s.both() // creates the root page
	rootID, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	sum, _, err := s.pages.Create(context.Background(), s.owner, s.f.WS, pages.CreateInput{ParentID: rootID.RootPageID, Title: "Plan Q4"})
	if err != nil {
		t.Fatal(err)
	}
	s.editLocal(sum.Id, nil, str("Details here"))

	s.both()

	is := s.gh.get(1)
	if is.Title != "Plan Q4" || !strings.HasPrefix(is.Body, "Details here") || !strings.Contains(is.Body, PageMarker(sum.Id)) {
		t.Fatalf("issue = %q / %q", is.Title, is.Body)
	}
	p, link := s.pageFor(1)
	if p.ID != sum.Id || p.Icon == nil || *p.Icon != iconOpen || link.CommentThreadID == nil {
		t.Fatalf("link = %+v icon %v", link, p.Icon)
	}

	applied := s.app.count()
	s.both()
	s.both()
	if s.gh.count("create issue") != 1 || s.gh.count("patch issue") != 0 || s.app.count() != applied {
		t.Fatalf("not idempotent: create=%d patch=%d applied=%d->%d", s.gh.count("create issue"), s.gh.count("patch issue"), applied, s.app.count())
	}
	if n := s.childCount(); n != 1 {
		t.Fatalf("%d pages under root", n)
	}
}

func TestUntitledPagesWaitForATitle(t *testing.T) {
	s := newScenario(t)
	s.both()
	c, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	if _, _, err := s.pages.Create(context.Background(), s.owner, s.f.WS, pages.CreateInput{ParentID: c.RootPageID, Title: ""}); err != nil {
		t.Fatal(err)
	}
	s.both()
	if s.gh.count("create issue") != 0 {
		t.Fatal("an untitled page was published as an issue")
	}
}

func TestAdoptsAnIssueWhoseLinkWasLost(t *testing.T) {
	s := newScenario(t)
	s.both()
	c, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	sum, _, _ := s.pages.Create(context.Background(), s.owner, s.f.WS, pages.CreateInput{ParentID: c.RootPageID, Title: "Orphan"})
	s.editLocal(sum.Id, nil, str("text"))
	// The process died after opening the issue and before storing the link.
	s.gh.addIssue("Orphan", "text\n\n"+PageMarker(sum.Id))

	s.both()

	if _, link := s.pageFor(1); link.PageID != sum.Id {
		t.Fatalf("issue #1 linked to %s, want the existing page", link.PageID)
	}
	if n := s.childCount(); n != 1 || s.gh.count("create issue") != 0 {
		t.Fatalf("duplicate: %d pages, %d issues created", n, s.gh.count("create issue"))
	}
}

func TestGitHubCommentsAreMirroredWithAttribution(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.gh.comment(1, "octocat", "Looks good to me")
	s.both()

	_, link := s.pageFor(1)
	thread := s.thread(link)
	if len(thread) != 2 {
		t.Fatalf("thread has %d comments, want intro + mirrored: %+v", len(thread), thread)
	}
	if !strings.HasPrefix(thread[1].Body, "**@octocat** commented on GitHub") || !strings.Contains(thread[1].Body, "Looks good to me") {
		t.Fatalf("mirrored comment = %q", thread[1].Body)
	}
	if s.gh.count("create comment") != 0 {
		t.Fatal("a GitHub comment was posted back to GitHub")
	}
	s.both()
	if got := len(s.thread(link)); got != 2 {
		t.Fatalf("second pass duplicated comments: %d", got)
	}
}

func TestHostidianCommentsArePostedWithFooterAndNeverBounce(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.both()
	_, link := s.pageFor(1)

	reply, err := s.cmts.Reply(context.Background(), s.owner, *link.CommentThreadID, "Thanks, I will fix it")
	if err != nil {
		t.Fatal(err)
	}
	s.both()

	posted := s.gh.allComments()
	if len(posted) != 1 {
		t.Fatalf("%d GitHub comments, want 1", len(posted))
	}
	for _, want := range []string{"Thanks, I will fix it", "via Hostidian, by owner", CommentMarker(reply.Id)} {
		if !strings.Contains(posted[0].Body, want) {
			t.Fatalf("GitHub comment %q lacks %q", posted[0].Body, want)
		}
	}
	for i := 0; i < 3; i++ {
		s.both()
	}
	if s.gh.count("create comment") != 1 || len(s.thread(link)) != 2 {
		t.Fatalf("comment bounced: posted=%d, thread=%d", s.gh.count("create comment"), len(s.thread(link)))
	}

	// Lost link row (crash after posting): the marker re-links it instead of mirroring a duplicate.
	s.f.Exec(`DELETE FROM github_comment_links WHERE origin = 'hostidian'`)
	if err := s.f.Q.ResetGithubConnectionCursors(context.Background(), s.conn.ID); err != nil {
		t.Fatal(err)
	}
	s.both()
	if len(s.thread(link)) != 2 || s.gh.count("create comment") != 1 {
		t.Fatalf("after re-link: thread=%d posted=%d", len(s.thread(link)), s.gh.count("create comment"))
	}
	var linked int
	_ = s.f.Pool.QueryRow(context.Background(), `SELECT count(*) FROM github_comment_links WHERE origin = 'hostidian'`).Scan(&linked)
	if linked != 1 {
		t.Fatalf("link not restored: %d", linked)
	}
}

func TestGitHubCommentEditsAndDeletesFollow(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	c := s.gh.comment(1, "octocat", "first take")
	s.both()
	_, link := s.pageFor(1)

	s.gh.mu.Lock()
	c.Body, c.Updated = "second take", s.gh.tick()
	s.gh.mu.Unlock()
	s.both()
	if th := s.thread(link); !strings.Contains(th[1].Body, "second take") {
		t.Fatalf("edit not mirrored: %q", th[1].Body)
	}

	if err := s.engine.DeleteMirroredComment(context.Background(), s.conn.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	if got := len(s.thread(link)); got != 1 {
		t.Fatalf("deleted comment still mirrored: %d", got)
	}
}

func TestClosingFromHostidianPushesStateAndIsNotRepulled(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)

	if err := s.engine.SetIssueState(context.Background(), s.owner, p.ID, "closed"); err != nil {
		t.Fatal(err)
	}
	if s.gh.get(1).State != "closed" {
		t.Fatal("issue still open on GitHub")
	}
	got, _ := s.f.Q.GetPage(context.Background(), p.ID)
	if *got.Icon != iconClosed {
		t.Fatalf("icon = %q", *got.Icon)
	}
	s.both()
	if s.gh.count("patch issue") != 1 {
		t.Fatalf("state change was sent %d times", s.gh.count("patch issue"))
	}

	s.gh.edit(1, func(i *ghIssue) { i.State = "open" })
	s.both()
	got, _ = s.f.Q.GetPage(context.Background(), p.ID)
	if *got.Icon != iconOpen {
		t.Fatalf("reopen on GitHub not reflected: %q", *got.Icon)
	}
}

func TestPickedIconsSurviveStateChanges(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)
	if _, err := s.pages.Update(context.Background(), s.owner, p.ID, pages.UpdateInput{SetIcon: true, Icon: str("🔥")}); err != nil {
		t.Fatal(err)
	}
	s.gh.edit(1, func(i *ghIssue) { i.State = "closed" })
	s.both()
	got, _ := s.f.Q.GetPage(context.Background(), p.ID)
	if *got.Icon != "🔥" {
		t.Fatalf("sync replaced a chosen icon with %q", *got.Icon)
	}
}

func TestFailedItemsAreRecordedAndRetried(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body to copy")
	s.app.err = collabclient.ErrNotConfigured
	s.both()

	p, link := s.pageFor(1)
	if link.SyncError == nil {
		t.Fatal("copy failure not recorded on the page")
	}
	c, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	if c.BackfilledAt != nil {
		t.Fatal("backfill marked complete although an issue failed")
	}

	s.app.err = nil
	s.both()
	_, link = s.pageFor(1)
	if link.SyncError != nil || s.markdown(p.ID) != "body to copy" {
		t.Fatalf("not retried: error=%v body=%q", link.SyncError, s.markdown(p.ID))
	}
	c, _ = s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
	if c.BackfilledAt == nil {
		t.Fatal("backfill never completed")
	}
}

func TestPushFailureIsRecordedThenCleared(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.both()
	p, _ := s.pageFor(1)
	s.editLocal(p.ID, str("New title"), nil)
	s.gh.fail["patch issue"] = 422
	s.both()
	if _, link := s.pageFor(1); link.SyncError == nil {
		t.Fatal("push failure not recorded")
	}
	s.both()
	if _, link := s.pageFor(1); link.SyncError != nil || s.gh.get(1).Title != "New title" {
		t.Fatalf("retry failed: err=%v title=%q", link.SyncError, s.gh.get(1).Title)
	}
}

func TestRestoredPageCatchesUpWithChangesMadeWhileInTrash(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "v1")
	s.both()
	p, _ := s.pageFor(1)
	if err := s.pages.Archive(context.Background(), s.owner, p.ID); err != nil {
		t.Fatal(err)
	}
	s.gh.edit(1, func(i *ghIssue) { i.Body = "v2" })
	s.both()
	if s.markdown(p.ID) != "v1" {
		t.Fatalf("trashed page was written: %q", s.markdown(p.ID))
	}
	if _, err := s.pages.Restore(context.Background(), s.owner, p.ID); err != nil {
		t.Fatal(err)
	}
	s.both()
	if s.markdown(p.ID) != "v2" {
		t.Fatalf("restored page did not catch up: %q", s.markdown(p.ID))
	}
}

func TestBadCredentialsOrLostAdminAreReportedOnTheConnection(t *testing.T) {
	t.Run("sync user is no longer an admin", func(t *testing.T) {
		s := newScenario(t)
		s.f.Exec(`UPDATE workspace_members SET role = 'member' WHERE user_id = $1`, s.owner)
		if err := s.engine.Sync(context.Background(), s.conn.ID, Mode{Pull: true}); err == nil {
			t.Fatal("expected an error")
		}
		c, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
		if c.LastError == nil || !strings.Contains(*c.LastError, "no longer an owner or admin") {
			t.Fatalf("last_error = %v", c.LastError)
		}
	})
	t.Run("GitHub rejects the token", func(t *testing.T) {
		s := newScenario(t)
		s.gh.fail["list issues"] = 401
		if err := s.engine.Sync(context.Background(), s.conn.ID, Mode{Pull: true}); err == nil {
			t.Fatal("expected an error")
		}
		c, _ := s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
		if c.LastError == nil || !strings.Contains(*c.LastError, "rejected the token") {
			t.Fatalf("last_error = %v", c.LastError)
		}
		s.both() // recovers on the next pass
		c, _ = s.f.Q.GetGithubConnection(context.Background(), s.conn.ID)
		if c.LastError != nil {
			t.Fatalf("error not cleared: %v", *c.LastError)
		}
	})
}

func TestPurgedRootTriggersAFullReimport(t *testing.T) {
	s := newScenario(t)
	s.gh.addIssue("Fix login", "body")
	s.both()
	s.f.Exec(`DELETE FROM pages WHERE id = $1`, s.rootID())
	s.both()
	if n := s.childCount(); n != 1 {
		t.Fatalf("%d pages after re-import", n)
	}
	if p, _ := s.pageFor(1); s.markdown(p.ID) != "body" {
		t.Fatal("re-imported page has no body")
	}
}

// thread lists the comments of a synced page's GitHub thread.
func (s *scenario) thread(link sqlcgen.GithubIssueLink) []sqlcgen.ListThreadCommentsRow {
	s.t.Helper()
	rows, err := s.f.Q.ListThreadComments(context.Background(), []uuid.UUID{*link.CommentThreadID})
	if err != nil {
		s.t.Fatal(err)
	}
	return rows
}
