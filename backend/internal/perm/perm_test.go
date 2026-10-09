package perm_test

import (
	"context"
	"fmt"
	"math/rand"
	"testing"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/testutil"
)

// scenarioFixture is the tree used by the hand-written matrix:
//
//	W  (workspace root, created by alice)
//	├─ W1
//	│  ├─ W2
//	│  └─ W3
//	P  (private root, created by alice)
//	└─ P1
//	   └─ P2
//	Q  (private root, created by bob)
//	└─ Q1
//	G  (workspace root, created by alice)
//	└─ G1 (created by gina, the guest - only possible with a grant on G, see the cases)
//	   ├─ G2 (created by alice)
//	   └─ G3 (created by bob)
//
// Creator ownership (conventions §3): whoever created a page holds an implicit full grant on it,
// inherited by its descendants like an explicit grant. In the tree above that means e.g. alice is
// full on W, W1, W2 (inherited from W1), W3, bob is full on W2 (his own page) but only edit on W1.
//
// Users: owen=owner, adam=admin, alice/bob=member, gina=guest, olga=not in the workspace.
func scenarioFixture(t *testing.T) *testutil.Fixture {
	f := testutil.NewFixture(t)
	f.Member("owen", "owner")
	f.Member("adam", "admin")
	f.Member("alice", "member")
	f.Member("bob", "member")
	f.Member("gina", "guest")
	f.User("olga")

	f.Page("W", "", "workspace", "alice")
	f.Page("W1", "W", "workspace", "alice")
	f.Page("W2", "W1", "workspace", "bob")
	f.Page("W3", "W1", "workspace", "alice")
	f.Page("P", "", "private", "alice")
	f.Page("P1", "P", "workspace", "alice")
	f.Page("P2", "P1", "workspace", "bob")
	f.Page("Q", "", "private", "bob")
	f.Page("Q1", "Q", "workspace", "bob")
	f.Page("G", "", "workspace", "alice")
	f.Page("G1", "G", "workspace", "gina")
	f.Page("G2", "G1", "workspace", "alice")
	f.Page("G3", "G1", "workspace", "bob")
	return f
}

type grant struct{ page, user, role string }

type check struct {
	user, page string
	want       perm.Role
}

func TestResolveMatrix(t *testing.T) {
	const (
		N, V, C, E, F = perm.None, perm.View, perm.Comment, perm.Edit, perm.Full
	)
	cases := []struct {
		name   string
		grants []grant
		checks []check
	}{
		{
			name: "no explicit grants: workspace role x visibility",
			checks: []check{
				// owners/admins: full on everything, private included
				{"owen", "W", F}, {"owen", "W2", F}, {"owen", "P", F}, {"owen", "P2", F}, {"owen", "Q1", F},
				{"adam", "W", F}, {"adam", "W3", F}, {"adam", "P1", F}, {"adam", "Q", F},
				// members: edit on other people's workspace pages, nothing in other people's private trees
				{"bob", "W", E}, {"bob", "W1", E}, {"bob", "W3", E}, {"alice", "Q", N}, {"alice", "Q1", N},
				{"alice", "P", F}, {"alice", "P1", F}, {"alice", "P2", F}, // creator of the private root
				{"bob", "P", N}, {"bob", "P1", N}, // not his tree
				{"bob", "Q", F}, {"bob", "Q1", F},
				// guests see nothing unless shared (or created by them, see below)
				{"gina", "W", N}, {"gina", "W2", N}, {"gina", "P", N}, {"gina", "Q1", N}, {"gina", "G", N},
				// outsiders get nothing at all
				{"olga", "W", N}, {"olga", "P", N}, {"olga", "Q1", N},
			},
		},
		{
			name: "creator ownership: full on own pages, inherited downwards",
			checks: []check{
				{"alice", "W", F}, {"alice", "W1", F}, {"alice", "W3", F},
				{"alice", "W2", F}, // created by bob, but inherited from alice's W1
				{"bob", "W2", F},   // his own page
				{"bob", "W1", E},   // above his page: nothing inherited upwards
				{"bob", "W", E},    // sibling/ancestor pages stay edit
				{"alice", "G", F}, {"alice", "G1", F}, {"alice", "G2", F}, {"alice", "G3", F},
				{"bob", "G", E}, {"bob", "G1", E}, {"bob", "G2", E}, {"bob", "G3", F},
				// a member who wrote a page inside someone's private tree owns that page (and below),
				// even though they cannot see the tree itself
				{"bob", "P2", F}, {"bob", "P", N}, {"bob", "P1", N},
				{"alice", "Q", N},
			},
		},
		{
			name: "creator ownership: guests own what they created",
			checks: []check{
				{"gina", "G", N},  // no grant on the parent: she sees nothing above her own page
				{"gina", "G1", F}, // the page she created
				{"gina", "G2", F}, // inherited from G1, although alice wrote it
				{"gina", "G3", F},
				{"alice", "G1", F},
			},
		},
		{
			name:   "creator ownership: explicit grant on the same page combines by max",
			grants: []grant{{"W1", "alice", "view"}, {"W2", "bob", "comment"}, {"G1", "gina", "view"}},
			checks: []check{
				{"alice", "W1", F}, {"alice", "W2", F}, // her own page stays full; the view does not lower it
				{"bob", "W2", F}, {"bob", "W1", E},
				{"gina", "G1", F}, {"gina", "G2", F}, // guest: explicit view on her own page, still full
			},
		},
		{
			name:   "creator ownership: a nearer explicit grant on a descendant overrides inherited ownership",
			grants: []grant{{"W2", "alice", "view"}, {"G2", "gina", "view"}, {"G3", "gina", "comment"}},
			checks: []check{
				{"alice", "W1", F},
				{"alice", "W2", E},                   // explicit view beats inherited full, floored at the member base
				{"alice", "W3", F},                   // siblings are unaffected
				{"gina", "G1", F},                    // her own page
				{"gina", "G2", V}, {"gina", "G3", C}, // guests have no base to floor at: the explicit grant is the answer
			},
		},
		{
			name:   "creator ownership: a lower explicit grant on an ancestor does not affect descendants owned deeper",
			grants: []grant{{"W", "bob", "view"}},
			checks: []check{
				{"bob", "W", E}, {"bob", "W1", E}, {"bob", "W2", F}, {"bob", "W3", E},
			},
		},
		{
			name:   "grant on a root is inherited by every descendant",
			grants: []grant{{"W", "gina", "view"}},
			checks: []check{
				{"gina", "W", V}, {"gina", "W1", V}, {"gina", "W2", V}, {"gina", "W3", V},
				{"gina", "P", N}, {"gina", "Q", N},
			},
		},
		{
			name:   "grant on a middle page covers its subtree only",
			grants: []grant{{"W1", "gina", "comment"}},
			checks: []check{
				{"gina", "W", N}, {"gina", "W1", C}, {"gina", "W2", C}, {"gina", "W3", C},
			},
		},
		{
			name:   "grant on a leaf covers only that leaf",
			grants: []grant{{"W2", "gina", "edit"}},
			checks: []check{
				{"gina", "W", N}, {"gina", "W1", N}, {"gina", "W2", E}, {"gina", "W3", N},
			},
		},
		{
			name:   "nearest grant wins over a farther one (can lower a guest)",
			grants: []grant{{"W", "gina", "full"}, {"W1", "gina", "view"}},
			checks: []check{
				{"gina", "W", F}, {"gina", "W1", V}, {"gina", "W2", V}, {"gina", "W3", V},
			},
		},
		{
			name:   "nearest grant wins over a farther one (can raise a guest)",
			grants: []grant{{"W", "gina", "view"}, {"W2", "gina", "full"}},
			checks: []check{
				{"gina", "W1", V}, {"gina", "W2", F}, {"gina", "W3", V},
			},
		},
		{
			name:   "a grant never lowers a member below the workspace base",
			grants: []grant{{"W2", "alice", "view"}, {"W3", "bob", "comment"}},
			checks: []check{
				{"alice", "W2", E}, {"bob", "W3", E}, {"bob", "W1", E}, {"alice", "W1", F},
			},
		},
		{
			name:   "a grant raises a member above the base",
			grants: []grant{{"W1", "bob", "full"}},
			checks: []check{
				{"bob", "W", E}, {"bob", "W1", F}, {"bob", "W2", F}, {"bob", "W3", F}, {"alice", "W1", F},
			},
		},
		{
			name:   "grants open a private tree to other members",
			grants: []grant{{"P", "bob", "view"}, {"P1", "alice", "view"}},
			checks: []check{
				{"bob", "P", V}, {"bob", "P1", V}, {"bob", "P2", F}, // P2 is his own page
				{"alice", "P", F}, {"alice", "P1", F}, // creator keeps full
				{"bob", "Q", F}, {"alice", "Q", N},
			},
		},
		{
			name:   "grant deeper inside a private tree exposes only that subtree",
			grants: []grant{{"P1", "bob", "edit"}},
			checks: []check{
				{"bob", "P", N}, {"bob", "P1", E}, {"bob", "P2", F}, // P2 is his own page
			},
		},
		{
			name:   "private tree: a lower nearest grant does not lower the creator",
			grants: []grant{{"P", "alice", "view"}},
			checks: []check{{"alice", "P", F}, {"alice", "P2", F}},
		},
		{
			name:   "owners/admins stay full whatever grants say",
			grants: []grant{{"W", "owen", "view"}, {"W1", "adam", "view"}},
			checks: []check{{"owen", "W", F}, {"adam", "W1", F}, {"adam", "W2", F}},
		},
		{
			name:   "a grant cannot give an outsider access (not a workspace member)",
			grants: []grant{{"W", "olga", "full"}},
			checks: []check{{"olga", "W", N}, {"olga", "W2", N}},
		},
		{
			name:   "grants are per user",
			grants: []grant{{"W1", "gina", "edit"}},
			checks: []check{{"gina", "W2", E}, {"bob", "W2", F}, {"olga", "W2", N}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := scenarioFixture(t)
			for _, g := range tc.grants {
				f.Grant(g.page, g.user, g.role)
			}
			ctx := context.Background()
			for _, c := range tc.checks {
				a, err := perm.Resolve(ctx, f.Q, f.Users[c.user], f.Pages[c.page])
				if err != nil {
					t.Fatal(err)
				}
				if a.Role != c.want {
					t.Errorf("Resolve(%s on %s) = %v, want %v", c.user, c.page, a.Role, c.want)
				}
			}
			// The set-based path must agree with the single-page path for every (user, page).
			for user, uid := range f.Users {
				all, err := perm.ResolveWorkspace(ctx, f.Q, f.WS, uid)
				if err != nil {
					t.Fatal(err)
				}
				for page, pid := range f.Pages {
					single, err := perm.Resolve(ctx, f.Q, uid, pid)
					if err != nil {
						t.Fatal(err)
					}
					if all[pid] != single.Role {
						t.Errorf("%s on %s: workspace-wide %v != single-page %v", user, page, all[pid], single.Role)
					}
				}
			}
		})
	}
}

func TestCreatorOwnershipRequiresMembership(t *testing.T) {
	f := scenarioFixture(t)
	ctx := context.Background()
	role := func(user, page string) perm.Role {
		a, err := perm.Resolve(ctx, f.Q, f.Users[user], f.Pages[page])
		if err != nil {
			t.Fatal(err)
		}
		return a.Role
	}
	if role("gina", "G1") != perm.Full || role("bob", "W2") != perm.Full {
		t.Fatal("creators should own their pages while they are members")
	}
	f.Exec(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, f.WS, f.Users["gina"])
	f.Exec(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, f.WS, f.Users["bob"])
	for _, c := range [][2]string{{"gina", "G1"}, {"gina", "G2"}, {"bob", "W2"}, {"bob", "P2"}} {
		if r := role(c[0], c[1]); r != perm.None {
			t.Errorf("%s on %s = %v after leaving the workspace, want none", c[0], c[1], r)
		}
	}
	// the creator's authorship survives the user (created_by is not cleared), so a returning member
	// owns the page again
	f.Member("bob", "member")
	if role("bob", "W2") != perm.Full {
		t.Fatal("ownership should apply again after re-joining")
	}
}

func TestResolveParentVisible(t *testing.T) {
	f := scenarioFixture(t)
	f.Grant("W2", "gina", "view") // gina sees W2 but neither W1 nor W
	ctx := context.Background()

	a, err := perm.Resolve(ctx, f.Q, f.Users["gina"], f.Pages["W2"])
	if err != nil {
		t.Fatal(err)
	}
	if a.Role != perm.View || a.ParentVisible {
		t.Fatalf("gina on W2: role=%v parentVisible=%v, want view/false", a.Role, a.ParentVisible)
	}
	a, _ = perm.Resolve(ctx, f.Q, f.Users["alice"], f.Pages["W2"])
	if !a.ParentVisible {
		t.Fatal("alice should see W2's parent")
	}
	a, _ = perm.Resolve(ctx, f.Q, f.Users["alice"], f.Pages["W"])
	if a.ParentVisible || a.ParentID != nil {
		t.Fatal("a root has no visible parent")
	}
}

func TestResolveMissingPage(t *testing.T) {
	f := scenarioFixture(t)
	a, err := perm.Resolve(context.Background(), f.Q, f.Users["owen"], uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if a.Role != perm.None || a.Exists {
		t.Fatalf("missing page: %+v", a)
	}
}

func TestResolveOtherWorkspaceIsolation(t *testing.T) {
	f := scenarioFixture(t)
	other := f.Workspace("other")
	f.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, other, f.Users["olga"])
	// olga owns "other" but must not see the page of the main workspace
	a, err := perm.Resolve(context.Background(), f.Q, f.Users["olga"], f.Pages["W"])
	if err != nil {
		t.Fatal(err)
	}
	if a.Role != perm.None {
		t.Fatalf("cross-workspace leak: %v", a.Role)
	}
}

func TestRequire(t *testing.T) {
	f := scenarioFixture(t)
	f.Grant("W1", "gina", "comment")
	f.Archive("P")
	ctx := context.Background()

	status := func(err error) int {
		if err == nil {
			return 200
		}
		if e, ok := apperr.As(err); ok {
			return e.Status
		}
		t.Fatalf("unexpected non-app error: %v", err)
		return 0
	}

	tests := []struct {
		name string
		user string
		page string
		min  perm.Role
		opts []perm.Option
		want int
	}{
		{"enough role", "gina", "W2", perm.Comment, nil, 200},
		{"insufficient role is 403", "gina", "W2", perm.Edit, nil, 403},
		{"view only needs view", "gina", "W1", perm.View, nil, 200},
		{"no access is 404 (never 403)", "gina", "W", perm.View, nil, 404},
		{"private page of someone else is 404", "bob", "Q1", perm.View, nil, 200}, // bob created Q
		{"private page invisible", "alice", "Q1", perm.View, nil, 404},
		{"outsider is 404", "olga", "W", perm.View, nil, 404},
		{"unknown page is 404", "alice", "", perm.View, nil, 404},
		{"archived page, full holder, default is 409", "alice", "P", perm.View, nil, 409},
		{"archived page, full holder, AllowArchived is ok", "alice", "P", perm.Full, []perm.Option{perm.AllowArchived()}, 200},
		{"child of an archived page that is not archived itself", "alice", "P1", perm.View, nil, 200},
		{"archived page hidden from non-full roles", "bob", "P", perm.View, []perm.Option{perm.AllowArchived()}, 404},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pid := f.Pages[tc.page]
			if tc.page == "" {
				pid = uuid.New()
			}
			_, err := perm.Require(ctx, f.Q, f.Users[tc.user], pid, tc.min, tc.opts...)
			if got := status(err); got != tc.want {
				t.Fatalf("status = %d (%v), want %d", got, err, tc.want)
			}
		})
	}
}

func TestVisibilityOnChildrenIsIgnored(t *testing.T) {
	f := scenarioFixture(t)
	// A child row stored with visibility=private must not hide it from members of a workspace tree,
	// and a workspace child of a private root stays private (conventions §3).
	f.Exec(`UPDATE pages SET visibility = 'private' WHERE id = $1`, f.Pages["W3"])
	f.Exec(`UPDATE pages SET visibility = 'workspace' WHERE id = $1`, f.Pages["Q1"])
	ctx := context.Background()
	if a, _ := perm.Resolve(ctx, f.Q, f.Users["bob"], f.Pages["W3"]); a.Role != perm.Edit {
		t.Fatalf("bob on W3 = %v, want edit", a.Role)
	}
	if a, _ := perm.Resolve(ctx, f.Q, f.Users["alice"], f.Pages["Q1"]); a.Role != perm.None {
		t.Fatalf("alice on Q1 = %v, want none", a.Role)
	}
}

func TestArchivedRowsAreStillResolved(t *testing.T) {
	// The resolver itself ignores archived_at; archived handling is Require's job. Exports/trash
	// rely on being able to resolve roles of archived pages.
	f := scenarioFixture(t)
	f.Archive("W1")
	a, err := perm.Resolve(context.Background(), f.Q, f.Users["bob"], f.Pages["W1"])
	if err != nil {
		t.Fatal(err)
	}
	if a.Role != perm.Edit || !a.Archived() {
		t.Fatalf("got role=%v archived=%v", a.Role, a.Archived())
	}
}

func TestWorkspaceRoleHelpers(t *testing.T) {
	f := scenarioFixture(t)
	ctx := context.Background()

	if r, err := perm.RequireMember(ctx, f.Q, f.WS, f.Users["gina"]); err != nil || r != perm.Guest {
		t.Fatalf("RequireMember(gina) = %v, %v", r, err)
	}
	if _, err := perm.RequireMember(ctx, f.Q, f.WS, f.Users["olga"]); !perm.IsNotFound(err) {
		t.Fatalf("outsider must get 404, got %v", err)
	}
	if _, err := perm.RequireWorkspaceAdmin(ctx, f.Q, f.WS, f.Users["alice"]); err == nil {
		t.Fatal("member must not pass RequireWorkspaceAdmin")
	} else if e, _ := apperr.As(err); e.Status != 403 {
		t.Fatalf("member got %d, want 403", e.Status)
	}
	if _, err := perm.RequireWorkspaceAdmin(ctx, f.Q, f.WS, f.Users["adam"]); err != nil {
		t.Fatalf("admin rejected: %v", err)
	}
}

// oracle is an independent, deliberately naive Go model of conventions §3 used to cross-check the SQL.
type oraclePage struct {
	parent     int // index, -1 for roots
	visibility string
	creator    int
}

func oracleRole(pages []oraclePage, grants map[[2]int]perm.Role, wsRole map[int]string, user, page int) perm.Role {
	role, ok := wsRole[user]
	if !ok {
		return perm.None
	}
	if role == "owner" || role == "admin" {
		return perm.Full
	}
	// walk up: remember the nearest page that carries a grant for the user. A page carries an
	// implicit full grant for its creator (creator ownership) or the user's explicit grant;
	// on the same page they combine by max, which for the top rank means "creator is full".
	nearest := perm.None
	found := false
	cur := page
	for {
		if !found {
			if pages[cur].creator == user {
				nearest, found = perm.Full, true
			} else if g, ok := grants[[2]int{cur, user}]; ok {
				nearest, found = g, true
			}
		}
		if pages[cur].parent < 0 {
			break
		}
		cur = pages[cur].parent
	}
	root := pages[cur]
	base := perm.None
	switch {
	case root.visibility == "private":
		if root.creator == user {
			base = perm.Full
		}
	case role == "member":
		base = perm.Edit
	}
	if nearest > base {
		return nearest
	}
	return base
}

func TestResolveMatchesOracleOnRandomForests(t *testing.T) {
	roles := []string{"owner", "admin", "member", "member", "guest", "guest"}
	grantRoles := []perm.Role{perm.View, perm.Comment, perm.Edit, perm.Full}
	const users = 8 // users 0..5 are members with the roles above, 6 and 7 are outsiders

	for seed := int64(1); seed <= 8; seed++ {
		t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			f := testutil.NewFixture(t)
			names := make([]string, users)
			wsRole := map[int]string{}
			for i := range names {
				names[i] = fmt.Sprintf("u%d", i)
				if i < len(roles) {
					f.Member(names[i], roles[i])
					wsRole[i] = roles[i]
				} else {
					f.User(names[i])
				}
			}

			// random forest of 70 pages, depth up to ~6; parents always created before children
			const n = 70
			pages := make([]oraclePage, n)
			pageNames := make([]string, n)
			for i := 0; i < n; i++ {
				pageNames[i] = fmt.Sprintf("p%d", i)
				parent := -1
				if i > 0 && rng.Intn(6) != 0 {
					parent = rng.Intn(i)
				}
				vis := "workspace"
				if parent < 0 && rng.Intn(2) == 0 {
					vis = "private"
				}
				creator := rng.Intn(users) // outsiders (6, 7) may be recorded as creators too: they still get nothing
				pages[i] = oraclePage{parent: parent, visibility: vis, creator: creator}
				parentName := ""
				if parent >= 0 {
					parentName = pageNames[parent]
				}
				f.Page(pageNames[i], parentName, vis, names[creator])
			}
			// children store the default visibility regardless of the (ignored) root value
			grants := map[[2]int]perm.Role{}
			for i := 0; i < 40; i++ {
				p, u := rng.Intn(n), rng.Intn(users)
				r := grantRoles[rng.Intn(len(grantRoles))]
				grants[[2]int{p, u}] = r
				f.Grant(pageNames[p], names[u], r.String())
			}

			ctx := context.Background()
			for u := 0; u < users; u++ {
				all, err := perm.ResolveWorkspace(ctx, f.Q, f.WS, f.Users[names[u]])
				if err != nil {
					t.Fatal(err)
				}
				for p := 0; p < n; p++ {
					want := oracleRole(pages, grants, wsRole, u, p)
					if got := all[f.Pages[pageNames[p]]]; got != want {
						t.Fatalf("user %s (%s) page %s: SQL=%v oracle=%v", names[u], wsRole[u], pageNames[p], got, want)
					}
				}
				// spot-check the single-page path (ancestor-closure optimisation)
				for k := 0; k < 15; k++ {
					p := rng.Intn(n)
					a, err := perm.Resolve(ctx, f.Q, f.Users[names[u]], f.Pages[pageNames[p]])
					if err != nil {
						t.Fatal(err)
					}
					if want := oracleRole(pages, grants, wsRole, u, p); a.Role != want {
						t.Fatalf("single-page: user %s page %s: SQL=%v oracle=%v", names[u], pageNames[p], a.Role, want)
					}
				}
			}

			// batch API agrees too
			ids := []uuid.UUID{f.Pages["p3"], f.Pages["p17"], f.Pages["p42"]}
			m, err := perm.ResolveMany(ctx, f.Q, f.WS, f.Users["u2"], ids)
			if err != nil {
				t.Fatal(err)
			}
			for _, id := range ids {
				single, _ := perm.Resolve(ctx, f.Q, f.Users["u2"], id)
				if m[id] != single.Role {
					t.Fatalf("ResolveMany %v != Resolve %v", m[id], single.Role)
				}
			}
		})
	}
}
