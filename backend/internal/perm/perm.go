// Package perm is the single source of truth for "what can this user do with this page".
//
// The rules (docs/conventions.md §3) are implemented exactly once, as the set-based SQL function
// effective_page_roles() in migrations/00002_perm_functions.sql. This package is the Go face of it:
// Resolve/Require for a single page, ResolveMany/ResolveWorkspace for batches. Search, graph,
// backlinks and the SSE broker either call these helpers or JOIN effective_page_roles() directly;
// nothing else may re-implement permission logic.
package perm

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
)

// Role is a page role. The numeric values equal role_rank in SQL.
type Role int

const (
	None Role = iota
	View
	Comment
	Edit
	Full
)

var roleNames = [...]string{"none", "view", "comment", "edit", "full"}

func (r Role) String() string {
	if r < None || r > Full {
		return "none"
	}
	return roleNames[r]
}

// AtLeast reports whether r grants at least min.
func (r Role) AtLeast(min Role) bool { return r >= min }

// ParseRole parses a stored/explicit-grant role name (view|comment|edit|full).
func ParseRole(s string) (Role, bool) {
	switch s {
	case "view":
		return View, true
	case "comment":
		return Comment, true
	case "edit":
		return Edit, true
	case "full":
		return Full, true
	}
	return None, false
}

// FromRank converts SQL role_rank into a Role.
func FromRank(rank int32) Role {
	if rank < 0 || rank > int32(Full) {
		return None
	}
	return Role(rank)
}

// WorkspaceRole is a role in workspace_members.
type WorkspaceRole string

const (
	Owner  WorkspaceRole = "owner"
	Admin  WorkspaceRole = "admin"
	Member WorkspaceRole = "member"
	Guest  WorkspaceRole = "guest"
)

func (w WorkspaceRole) Valid() bool {
	switch w {
	case Owner, Admin, Member, Guest:
		return true
	}
	return false
}

// IsAdmin is true for owners and admins (full access to every page of the workspace).
func (w WorkspaceRole) IsAdmin() bool { return w == Owner || w == Admin }

// CanCreateRootPages: guests only ever work inside pages shared with them.
func (w WorkspaceRole) CanCreateRootPages() bool { return w == Owner || w == Admin || w == Member }

// Access is a caller's standing on one page.
type Access struct {
	PageID      uuid.UUID
	WorkspaceID uuid.UUID
	ParentID    *uuid.UUID
	Role        Role
	ArchivedAt  *time.Time
	// ParentVisible is true when the caller can also view the parent page (false for roots).
	ParentVisible bool
	// Exists is false when the page row does not exist at all.
	Exists bool
}

func (a Access) Archived() bool { return a.ArchivedAt != nil }

// Resolve computes the caller's effective role on a page. A missing page resolves to Role None.
func Resolve(ctx context.Context, q *sqlcgen.Queries, userID, pageID uuid.UUID) (Access, error) {
	row, err := q.ResolvePageAccess(ctx, sqlcgen.ResolvePageAccessParams{UserID: userID, PageID: pageID})
	if err != nil {
		if db.IsNotFound(err) {
			return Access{PageID: pageID, Role: None}, nil
		}
		return Access{}, fmt.Errorf("resolve page access: %w", err)
	}
	return Access{
		PageID:        row.ID,
		WorkspaceID:   row.WorkspaceID,
		ParentID:      row.ParentID,
		Role:          FromRank(row.RoleRank),
		ArchivedAt:    row.ArchivedAt,
		ParentVisible: row.ParentVisible,
		Exists:        true,
	}, nil
}

type requireOpts struct{ allowArchived bool }

// Option tunes Require.
type Option func(*requireOpts)

// AllowArchived lets Require succeed on archived pages (restore, purge, trash previews). Only
// callers with Full access may see an archived page at all.
func AllowArchived() Option { return func(o *requireOpts) { o.allowArchived = true } }

// Require resolves the caller's access and enforces conventions §3:
//   - role none (or no such page) -> 404, so existence is never revealed;
//   - role >= view but < min      -> 403;
//   - archived pages are only visible to Full holders; without AllowArchived they answer 409.
func Require(ctx context.Context, q *sqlcgen.Queries, userID, pageID uuid.UUID, min Role, opts ...Option) (Access, error) {
	var o requireOpts
	for _, opt := range opts {
		opt(&o)
	}
	a, err := Resolve(ctx, q, userID, pageID)
	if err != nil {
		return Access{}, err
	}
	if a.Role == None || (a.Archived() && a.Role < Full) {
		return Access{}, ErrPageNotFound
	}
	if a.Archived() && !o.allowArchived {
		return Access{}, apperr.Conflict("This page is in the trash.")
	}
	if a.Role < min {
		return Access{}, apperr.Forbidden(forbiddenMessage(min))
	}
	return a, nil
}

// ErrPageNotFound is the 404 returned for missing and invisible pages alike.
var ErrPageNotFound = apperr.NotFound("Page not found.")

func forbiddenMessage(min Role) string {
	switch min {
	case Comment:
		return "You do not have permission to comment on this page."
	case Edit:
		return "You do not have permission to edit this page."
	case Full:
		return "You need full access to this page."
	}
	return "You do not have access to this page."
}

// ResolveMany returns the caller's role for each requested page of a workspace (missing and
// invisible pages map to None).
func ResolveMany(ctx context.Context, q *sqlcgen.Queries, workspaceID, userID uuid.UUID, pageIDs []uuid.UUID) (map[uuid.UUID]Role, error) {
	out := make(map[uuid.UUID]Role, len(pageIDs))
	if len(pageIDs) == 0 {
		return out, nil
	}
	rows, err := q.ResolvePageRoles(ctx, sqlcgen.ResolvePageRolesParams{WorkspaceID: workspaceID, UserID: userID, PageIds: pageIDs})
	if err != nil {
		return nil, fmt.Errorf("resolve page roles: %w", err)
	}
	for _, id := range pageIDs {
		out[id] = None
	}
	for _, r := range rows {
		out[r.PageID] = FromRank(r.RoleRank)
	}
	return out, nil
}

// ResolveWorkspace returns the caller's role for every page of a workspace (None entries omitted).
func ResolveWorkspace(ctx context.Context, q *sqlcgen.Queries, workspaceID, userID uuid.UUID) (map[uuid.UUID]Role, error) {
	rows, err := q.ResolveWorkspaceRoles(ctx, sqlcgen.ResolveWorkspaceRolesParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("resolve workspace roles: %w", err)
	}
	out := make(map[uuid.UUID]Role, len(rows))
	for _, r := range rows {
		if role := FromRank(r.RoleRank); role > None {
			out[r.PageID] = role
		}
	}
	return out, nil
}

// MemberRole returns the caller's workspace role; ok is false for non-members.
func MemberRole(ctx context.Context, q *sqlcgen.Queries, workspaceID, userID uuid.UUID) (role WorkspaceRole, ok bool, err error) {
	r, err := q.GetMemberRole(ctx, sqlcgen.GetMemberRoleParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		if db.IsNotFound(err) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("get member role: %w", err)
	}
	return WorkspaceRole(r), true, nil
}

// ErrWorkspaceNotFound hides workspaces from non-members.
var ErrWorkspaceNotFound = apperr.NotFound("Workspace not found.")

// RequireMember returns the workspace role or 404 for non-members.
func RequireMember(ctx context.Context, q *sqlcgen.Queries, workspaceID, userID uuid.UUID) (WorkspaceRole, error) {
	role, ok, err := MemberRole(ctx, q, workspaceID, userID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrWorkspaceNotFound
	}
	return role, nil
}

// RequireWorkspaceAdmin requires owner/admin (404 for non-members, 403 for other members).
func RequireWorkspaceAdmin(ctx context.Context, q *sqlcgen.Queries, workspaceID, userID uuid.UUID) (WorkspaceRole, error) {
	role, err := RequireMember(ctx, q, workspaceID, userID)
	if err != nil {
		return "", err
	}
	if !role.IsAdmin() {
		return "", apperr.Forbidden("Only workspace owners and admins can do this.")
	}
	return role, nil
}

// IsNotFound reports whether err is the 404 produced by this package.
func IsNotFound(err error) bool {
	var e *apperr.Error
	return errors.As(err, &e) && e.Status == 404
}
