package testutil

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/db/sqlcgen"
)

// Fixture builds users, workspace memberships and pages directly with SQL, so low-level packages
// (permission resolver, event broker, …) can be tested without the services that normally create
// those rows.
type Fixture struct {
	T     testing.TB
	Pool  *pgxpool.Pool
	Q     *sqlcgen.Queries
	WS    uuid.UUID // the "main" workspace
	Users map[string]uuid.UUID
	Pages map[string]uuid.UUID
}

// NewFixture creates a fresh database with an empty "main" workspace.
func NewFixture(t testing.TB) *Fixture {
	t.Helper()
	pool := NewDB(t)
	f := &Fixture{T: t, Pool: pool, Q: sqlcgen.New(pool), Users: map[string]uuid.UUID{}, Pages: map[string]uuid.UUID{}}
	f.WS = f.Workspace("main")
	return f
}

// Exec runs raw SQL and fails the test on error.
func (f *Fixture) Exec(sql string, args ...any) {
	f.T.Helper()
	if _, err := f.Pool.Exec(context.Background(), sql, args...); err != nil {
		f.T.Fatalf("exec %q: %v", sql, err)
	}
}

// Workspace creates another workspace.
func (f *Fixture) Workspace(slug string) uuid.UUID {
	f.T.Helper()
	var id uuid.UUID
	if err := f.Pool.QueryRow(context.Background(),
		`INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id`, slug).Scan(&id); err != nil {
		f.T.Fatal(err)
	}
	return id
}

// User creates (once) a user by name.
func (f *Fixture) User(name string) uuid.UUID {
	f.T.Helper()
	if id, ok := f.Users[name]; ok {
		return id
	}
	var id uuid.UUID
	if err := f.Pool.QueryRow(context.Background(),
		`INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`, name+"@example.com", name).Scan(&id); err != nil {
		f.T.Fatal(err)
	}
	f.Users[name] = id
	return id
}

// Member makes the user a member of the main workspace with the given role.
func (f *Fixture) Member(name, role string) uuid.UUID {
	f.T.Helper()
	id := f.User(name)
	f.Exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
	        ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`, f.WS, id, role)
	return id
}

// Page creates a page in the main workspace. parent is the name of an existing page ("" for a
// root); siblings sort by name.
func (f *Fixture) Page(name, parent, visibility, createdBy string) uuid.UUID {
	f.T.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		f.T.Fatal(err)
	}
	var parentID *uuid.UUID
	if parent != "" {
		p := f.Pages[parent]
		parentID = &p
	}
	f.Exec(`INSERT INTO pages (id, workspace_id, parent_id, title, position, visibility, created_by)
	        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, f.WS, parentID, name, "a"+name, visibility, f.User(createdBy))
	f.Pages[name] = id
	return id
}

// Grant stores an explicit page permission.
func (f *Fixture) Grant(page, user, role string) {
	f.T.Helper()
	f.Exec(`INSERT INTO page_permissions (page_id, user_id, role) VALUES ($1, $2, $3)
	        ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role`, f.Pages[page], f.User(user), role)
}

// Archive marks a single page archived (no subtree handling).
func (f *Fixture) Archive(page string) {
	f.T.Helper()
	f.Exec(`UPDATE pages SET archived_at = now() WHERE id = $1`, f.Pages[page])
}
