// Package workspaces implements workspaces, their members and invites.
package workspaces

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/tokens"
	"hostidian/backend/internal/validate"
)

// Service holds the workspace use cases.
type Service struct {
	pool      *pgxpool.Pool
	q         *sqlcgen.Queries
	broker    *events.Broker
	collab    collabclient.Disconnecter
	publicURL string
	log       *slog.Logger
	now       func() time.Time
}

type Options struct {
	Pool      *pgxpool.Pool
	Broker    *events.Broker
	Collab    collabclient.Disconnecter
	PublicURL string
	Log       *slog.Logger
	Now       func() time.Time
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Collab == nil {
		o.Collab = collabclient.Noop{}
	}
	return &Service{pool: o.Pool, q: sqlcgen.New(o.Pool), broker: o.Broker, collab: o.Collab, publicURL: o.PublicURL, log: o.Log, now: o.Now}
}

// CreateWithOwner creates a workspace and makes ownerID its owner, inside the caller's transaction.
// slug may be empty, in which case a unique one is derived from the name.
func CreateWithOwner(ctx context.Context, q *sqlcgen.Queries, ownerID uuid.UUID, name, slug string, icon *string) (sqlcgen.Workspace, error) {
	explicit := slug != ""
	if !explicit {
		var err error
		if slug, err = uniqueSlug(ctx, q, name); err != nil {
			return sqlcgen.Workspace{}, err
		}
	}
	ws, err := q.CreateWorkspace(ctx, sqlcgen.CreateWorkspaceParams{Name: name, Slug: slug, Icon: icon, CreatedBy: &ownerID})
	if err != nil {
		if db.IsUniqueViolation(err) {
			return sqlcgen.Workspace{}, apperr.Conflict("That workspace address is already taken.")
		}
		return sqlcgen.Workspace{}, fmt.Errorf("create workspace: %w", err)
	}
	if err := q.AddWorkspaceMember(ctx, sqlcgen.AddWorkspaceMemberParams{WorkspaceID: ws.ID, UserID: ownerID, Role: string(perm.Owner)}); err != nil {
		return sqlcgen.Workspace{}, fmt.Errorf("add owner: %w", err)
	}
	return ws, nil
}

func uniqueSlug(ctx context.Context, q *sqlcgen.Queries, name string) (string, error) {
	base := validate.Slugify(name)
	if base == "" {
		base = "workspace"
	}
	for i := 1; i <= 100; i++ {
		candidate := base
		if i > 1 {
			suffix := fmt.Sprintf("-%d", i)
			if len(base)+len(suffix) > validate.MaxSlugLen {
				candidate = base[:validate.MaxSlugLen-len(suffix)]
			}
			candidate += suffix
		}
		taken, err := q.WorkspaceSlugExists(ctx, candidate)
		if err != nil {
			return "", fmt.Errorf("check slug: %w", err)
		}
		if !taken {
			return candidate, nil
		}
	}
	id, _ := uuid.NewRandom()
	return base + "-" + strings.ReplaceAll(id.String(), "-", "")[:8], nil
}

// List returns the caller's workspaces.
func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]gen.WorkspaceMembership, error) {
	rows, err := s.q.ListWorkspacesForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	out := make([]gen.WorkspaceMembership, 0, len(rows))
	for _, r := range rows {
		out = append(out, MembershipToGen(r.Workspace, r.Role))
	}
	return out, nil
}

type CreateInput struct {
	Name string
	Slug *string
	Icon *string
}

// Create makes a workspace owned by the caller. Allowed for instance admins, and for everybody
// when instance_settings.allow_workspace_creation is set.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, instanceAdmin bool, in CreateInput) (gen.WorkspaceMembership, error) {
	name, err := validate.Name("name", in.Name)
	if err != nil {
		return gen.WorkspaceMembership{}, err
	}
	slug := ""
	if in.Slug != nil {
		if err := validate.Slug("slug", *in.Slug); err != nil {
			return gen.WorkspaceMembership{}, err
		}
		slug = *in.Slug
	}
	if in.Icon != nil {
		if err := validate.ShortString("icon", *in.Icon, 64); err != nil {
			return gen.WorkspaceMembership{}, err
		}
	}
	settings, err := s.q.GetInstanceSettings(ctx)
	if err != nil {
		return gen.WorkspaceMembership{}, fmt.Errorf("get settings: %w", err)
	}
	if !instanceAdmin && !settings.AllowWorkspaceCreation {
		return gen.WorkspaceMembership{}, apperr.Forbidden("Workspace creation is disabled on this instance.")
	}
	ws, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (sqlcgen.Workspace, error) {
		return CreateWithOwner(ctx, q, userID, name, slug, in.Icon)
	})
	if err != nil {
		return gen.WorkspaceMembership{}, err
	}
	return MembershipToGen(ws, string(perm.Owner)), nil
}

// Get returns one workspace (404 for non-members).
func (s *Service) Get(ctx context.Context, userID, workspaceID uuid.UUID) (gen.WorkspaceMembership, error) {
	row, err := s.q.GetWorkspaceMembership(ctx, sqlcgen.GetWorkspaceMembershipParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		if db.IsNotFound(err) {
			return gen.WorkspaceMembership{}, perm.ErrWorkspaceNotFound
		}
		return gen.WorkspaceMembership{}, fmt.Errorf("get workspace: %w", err)
	}
	return MembershipToGen(row.Workspace, row.Role), nil
}

type UpdateInput struct {
	Name    *string
	Slug    *string
	SetIcon bool
	Icon    *string
}

// Update changes name/slug/icon (owner/admin).
func (s *Service) Update(ctx context.Context, userID, workspaceID uuid.UUID, in UpdateInput) (gen.WorkspaceMembership, error) {
	role, err := perm.RequireWorkspaceAdmin(ctx, s.q, workspaceID, userID)
	if err != nil {
		return gen.WorkspaceMembership{}, err
	}
	params := sqlcgen.UpdateWorkspaceParams{ID: workspaceID, SetIcon: in.SetIcon, Icon: in.Icon}
	if in.Name != nil {
		name, err := validate.Name("name", *in.Name)
		if err != nil {
			return gen.WorkspaceMembership{}, err
		}
		params.Name = &name
	}
	if in.Slug != nil {
		if err := validate.Slug("slug", *in.Slug); err != nil {
			return gen.WorkspaceMembership{}, err
		}
		params.Slug = in.Slug
	}
	if in.SetIcon && in.Icon != nil {
		if err := validate.ShortString("icon", *in.Icon, 64); err != nil {
			return gen.WorkspaceMembership{}, err
		}
	}
	ws, err := s.q.UpdateWorkspace(ctx, params)
	if err != nil {
		if db.IsUniqueViolation(err) {
			return gen.WorkspaceMembership{}, apperr.Conflict("That workspace address is already taken.")
		}
		return gen.WorkspaceMembership{}, fmt.Errorf("update workspace: %w", err)
	}
	return MembershipToGen(ws, string(role)), nil
}

// Delete removes the workspace with all its pages and files (owner only).
func (s *Service) Delete(ctx context.Context, userID, workspaceID uuid.UUID) error {
	role, err := perm.RequireMember(ctx, s.q, workspaceID, userID)
	if err != nil {
		return err
	}
	if role != perm.Owner {
		return apperr.Forbidden("Only workspace owners can delete a workspace.")
	}
	pageIDs, err := s.q.ListWorkspacePageIDs(ctx, workspaceID)
	if err != nil {
		return fmt.Errorf("list pages: %w", err)
	}
	if err := s.q.DeleteWorkspace(ctx, workspaceID); err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}
	s.broker.CloseWorkspace(workspaceID, "workspace deleted")
	for _, id := range pageIDs {
		s.collab.Disconnect(collabclient.DisconnectRequest{PageID: id, Reason: "page_deleted"})
	}
	return nil
}

// ---------------------------------------------------------------- members

func memberToGen(r sqlcgen.GetWorkspaceMemberRow) gen.Member {
	return gen.Member{
		User:     gen.MemberUser{Id: r.UserID, Name: r.Name, Email: emailOf(r.Email), AvatarColor: r.AvatarColor},
		Role:     gen.WorkspaceRole(r.Role),
		JoinedAt: r.JoinedAt,
	}
}

// ListMembers returns the members the caller may see: owners/admins see everybody, regular members
// see everybody except guests, and guests only see themselves.
func (s *Service) ListMembers(ctx context.Context, userID, workspaceID uuid.UUID) ([]gen.Member, error) {
	role, err := perm.RequireMember(ctx, s.q, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListWorkspaceMembers(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list members: %w", err)
	}
	out := make([]gen.Member, 0, len(rows))
	for _, r := range rows {
		switch {
		case role.IsAdmin():
		case role == perm.Guest && r.UserID != userID:
			continue
		case r.Role == string(perm.Guest) && r.UserID != userID:
			continue
		}
		out = append(out, memberToGen(sqlcgen.GetWorkspaceMemberRow(r)))
	}
	return out, nil
}

// roleRank orders workspace roles for "was access reduced" checks.
func roleRank(r perm.WorkspaceRole) int {
	switch r {
	case perm.Owner:
		return 4
	case perm.Admin:
		return 3
	case perm.Member:
		return 2
	case perm.Guest:
		return 1
	}
	return 0
}

// UpdateMember changes a member's role. Owners/admins only; only owners may grant or revoke owner
// and touch admins; the last owner cannot be demoted.
func (s *Service) UpdateMember(ctx context.Context, actorID, workspaceID, targetID uuid.UUID, newRoleRaw string) (gen.Member, error) {
	newRole := perm.WorkspaceRole(newRoleRaw)
	if !newRole.Valid() {
		return gen.Member{}, apperr.FieldError("role", "Role must be owner, admin, member or guest.")
	}
	member, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (sqlcgen.GetWorkspaceMemberRow, error) {
		actorRole, err := perm.RequireWorkspaceAdmin(ctx, q, workspaceID, actorID)
		if err != nil {
			return sqlcgen.GetWorkspaceMemberRow{}, err
		}
		owners, err := q.LockWorkspaceOwners(ctx, workspaceID) // serializes concurrent owner changes
		if err != nil {
			return sqlcgen.GetWorkspaceMemberRow{}, fmt.Errorf("lock owners: %w", err)
		}
		target, err := q.GetWorkspaceMember(ctx, sqlcgen.GetWorkspaceMemberParams{WorkspaceID: workspaceID, UserID: targetID})
		if err != nil {
			if db.IsNotFound(err) {
				return sqlcgen.GetWorkspaceMemberRow{}, apperr.NotFound("Member not found.")
			}
			return sqlcgen.GetWorkspaceMemberRow{}, fmt.Errorf("get member: %w", err)
		}
		oldRole := perm.WorkspaceRole(target.Role)
		selfStepDown := actorID == targetID && oldRole == perm.Admin && (newRole == perm.Member || newRole == perm.Guest)
		if (oldRole == perm.Owner || newRole == perm.Owner || oldRole == perm.Admin) && actorRole != perm.Owner && !selfStepDown {
			return sqlcgen.GetWorkspaceMemberRow{}, apperr.Forbidden("Only workspace owners can change owners and admins.")
		}
		if oldRole == perm.Owner && newRole != perm.Owner && len(owners) <= 1 {
			return sqlcgen.GetWorkspaceMemberRow{}, apperr.Conflict("A workspace needs at least one owner.")
		}
		if oldRole != newRole {
			if _, err := q.UpdateWorkspaceMemberRole(ctx, sqlcgen.UpdateWorkspaceMemberRoleParams{WorkspaceID: workspaceID, UserID: targetID, Role: string(newRole)}); err != nil {
				return sqlcgen.GetWorkspaceMemberRow{}, fmt.Errorf("update member role: %w", err)
			}
			target.Role = string(newRole)
		}
		return target, nil
	})
	if err != nil {
		return gen.Member{}, err
	}
	s.afterMembershipChange(workspaceID, actorID, targetID, string(newRole), false)
	return memberToGen(member), nil
}

// AddMemberInput identifies the account to add (by id or by email) and the role to give it.
type AddMemberInput struct {
	UserID *uuid.UUID
	Email  *string
	Role   string
}

// AddMember adds an existing account to the workspace. Owners/admins only, and only owners may add
// admins. An unknown (or disabled) account is a 404 so the UI can offer an invite link instead; an
// account that is already a member is a 409 and keeps its current role.
func (s *Service) AddMember(ctx context.Context, actorID, workspaceID uuid.UUID, in AddMemberInput) (gen.Member, error) {
	role := perm.WorkspaceRole(in.Role)
	switch role {
	case perm.Admin, perm.Member, perm.Guest:
	default:
		return gen.Member{}, apperr.FieldError("role", "Role must be admin, member or guest.")
	}
	hasEmail := in.Email != nil && strings.TrimSpace(*in.Email) != ""
	if (in.UserID == nil) == !hasEmail {
		return gen.Member{}, apperr.FieldError("email", "Give either a user id or an email address.")
	}
	var email string
	if hasEmail {
		var err error
		if email, err = validate.Email("email", *in.Email); err != nil {
			return gen.Member{}, err
		}
	}
	member, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (sqlcgen.GetWorkspaceMemberRow, error) {
		actorRole, err := perm.RequireWorkspaceAdmin(ctx, q, workspaceID, actorID)
		if err != nil {
			return sqlcgen.GetWorkspaceMemberRow{}, err
		}
		if role == perm.Admin && actorRole != perm.Owner {
			return sqlcgen.GetWorkspaceMemberRow{}, apperr.Forbidden("Only workspace owners can add admins.")
		}
		var target sqlcgen.User
		if in.UserID != nil {
			target, err = q.GetUserByID(ctx, *in.UserID)
		} else {
			target, err = q.GetUserByEmail(ctx, email)
		}
		if err != nil {
			if db.IsNotFound(err) {
				return sqlcgen.GetWorkspaceMemberRow{}, apperr.NotFound("No account with that email address.")
			}
			return sqlcgen.GetWorkspaceMemberRow{}, fmt.Errorf("find account: %w", err)
		}
		if target.DisabledAt != nil {
			return sqlcgen.GetWorkspaceMemberRow{}, apperr.NotFound("No account with that email address.")
		}
		added, err := q.AddWorkspaceMemberIfMissing(ctx, sqlcgen.AddWorkspaceMemberIfMissingParams{
			WorkspaceID: workspaceID, UserID: target.ID, Role: string(role),
		})
		if err != nil {
			return sqlcgen.GetWorkspaceMemberRow{}, fmt.Errorf("add member: %w", err)
		}
		if added == 0 {
			return sqlcgen.GetWorkspaceMemberRow{}, apperr.Conflict("They are already a member of this workspace.")
		}
		row, err := q.GetWorkspaceMember(ctx, sqlcgen.GetWorkspaceMemberParams{WorkspaceID: workspaceID, UserID: target.ID})
		if err != nil {
			return sqlcgen.GetWorkspaceMemberRow{}, fmt.Errorf("load member: %w", err)
		}
		return row, nil
	})
	if err != nil {
		return gen.Member{}, err
	}
	s.broker.Publish(events.Event{
		Type: events.MemberChanged, WorkspaceID: workspaceID, ActorID: actorID,
		Data: map[string]any{"userId": member.UserID, "role": string(role), "removed": false},
	})
	return memberToGen(member), nil
}

// RemoveMember removes a member, or lets a member leave (targetID == actorID).
func (s *Service) RemoveMember(ctx context.Context, actorID, workspaceID, targetID uuid.UUID) error {
	err := db.InTx(ctx, s.pool, func(q *sqlcgen.Queries) error {
		actorRole, err := perm.RequireMember(ctx, q, workspaceID, actorID)
		if err != nil {
			return err
		}
		owners, err := q.LockWorkspaceOwners(ctx, workspaceID)
		if err != nil {
			return fmt.Errorf("lock owners: %w", err)
		}
		targetRole, ok, err := perm.MemberRole(ctx, q, workspaceID, targetID)
		if err != nil {
			return err
		}
		if !ok {
			if actorID == targetID || actorRole.IsAdmin() {
				return apperr.NotFound("Member not found.")
			}
			return apperr.Forbidden("Only workspace owners and admins can remove members.")
		}
		if actorID != targetID {
			if !actorRole.IsAdmin() {
				return apperr.Forbidden("Only workspace owners and admins can remove members.")
			}
			if (targetRole == perm.Owner || targetRole == perm.Admin) && actorRole != perm.Owner {
				return apperr.Forbidden("Only workspace owners can remove owners and admins.")
			}
		}
		if targetRole == perm.Owner && len(owners) <= 1 {
			return apperr.Conflict("A workspace needs at least one owner.")
		}
		if _, err := q.DeleteWorkspaceMember(ctx, sqlcgen.DeleteWorkspaceMemberParams{WorkspaceID: workspaceID, UserID: targetID}); err != nil {
			return fmt.Errorf("delete member: %w", err)
		}
		if err := q.DeleteUserPagePermissionsInWorkspace(ctx, sqlcgen.DeleteUserPagePermissionsInWorkspaceParams{WorkspaceID: workspaceID, UserID: targetID}); err != nil {
			return fmt.Errorf("delete grants: %w", err)
		}
		if err := q.DeleteUserFavoritesInWorkspace(ctx, sqlcgen.DeleteUserFavoritesInWorkspaceParams{WorkspaceID: workspaceID, UserID: targetID}); err != nil {
			return fmt.Errorf("delete favorites: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.afterMembershipChange(workspaceID, actorID, targetID, "", true)
	return nil
}

// afterMembershipChange revokes live access and tells the other clients (best effort).
func (s *Service) afterMembershipChange(workspaceID, actorID, targetID uuid.UUID, role string, removed bool) {
	if removed {
		s.broker.CloseMember(workspaceID, targetID, "removed from workspace")
	}
	s.collab.Disconnect(collabclient.DisconnectRequest{UserID: targetID, Reason: "permissions_changed"})
	data := map[string]any{"userId": targetID, "removed": removed}
	if !removed {
		data["role"] = role
	}
	s.broker.Publish(events.Event{Type: events.MemberChanged, WorkspaceID: workspaceID, ActorID: actorID, Data: data})
	s.broker.Publish(events.Event{Type: events.PermissionsChanged, WorkspaceID: workspaceID, ActorID: actorID, Audience: events.AudienceAll})
}

// ---------------------------------------------------------------- invites

type InviteInput struct {
	Role          string
	Email         *string
	ExpiresInDays *int
}

func (s *Service) CreateInvite(ctx context.Context, actorID, workspaceID uuid.UUID, in InviteInput) (gen.Invite, error) {
	if _, err := perm.RequireWorkspaceAdmin(ctx, s.q, workspaceID, actorID); err != nil {
		return gen.Invite{}, err
	}
	switch perm.WorkspaceRole(in.Role) {
	case perm.Admin, perm.Member, perm.Guest:
	default:
		return gen.Invite{}, apperr.FieldError("role", "Role must be admin, member or guest.")
	}
	var email *string
	if in.Email != nil && strings.TrimSpace(*in.Email) != "" {
		e, err := validate.Email("email", *in.Email)
		if err != nil {
			return gen.Invite{}, err
		}
		email = &e
	}
	days := 7
	if in.ExpiresInDays != nil {
		days = *in.ExpiresInDays
	}
	if days < 1 || days > 90 {
		return gen.Invite{}, apperr.FieldError("expiresInDays", "Must be between 1 and 90.")
	}
	token, err := tokens.New()
	if err != nil {
		return gen.Invite{}, err
	}
	inv, err := s.q.CreateInvite(ctx, sqlcgen.CreateInviteParams{
		TokenHash: tokens.Hash(token), Token: token, WorkspaceID: workspaceID, Role: in.Role,
		Email: email, CreatedBy: &actorID, ExpiresAt: s.now().Add(time.Duration(days) * 24 * time.Hour),
	})
	if err != nil {
		return gen.Invite{}, fmt.Errorf("create invite: %w", err)
	}
	return inviteToGen(inv, s.publicURL), nil
}

func (s *Service) ListInvites(ctx context.Context, actorID, workspaceID uuid.UUID) ([]gen.Invite, error) {
	if _, err := perm.RequireWorkspaceAdmin(ctx, s.q, workspaceID, actorID); err != nil {
		return nil, err
	}
	rows, err := s.q.ListPendingInvites(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	out := make([]gen.Invite, 0, len(rows))
	for _, r := range rows {
		out = append(out, inviteToGen(r, s.publicURL))
	}
	return out, nil
}

func (s *Service) RevokeInvite(ctx context.Context, actorID, workspaceID, inviteID uuid.UUID) error {
	if _, err := perm.RequireWorkspaceAdmin(ctx, s.q, workspaceID, actorID); err != nil {
		return err
	}
	n, err := s.q.DeleteInvite(ctx, sqlcgen.DeleteInviteParams{ID: inviteID, WorkspaceID: workspaceID})
	if err != nil {
		return fmt.Errorf("delete invite: %w", err)
	}
	if n == 0 {
		return apperr.NotFound("Invite not found.")
	}
	return nil
}

// Invite is a valid invite resolved from its token.
type Invite struct {
	Row           sqlcgen.Invite
	WorkspaceName string
}

// LookupInvite resolves an invite token to a valid (unused, unexpired) invite, or returns nil.
func LookupInvite(ctx context.Context, q *sqlcgen.Queries, token string) (*Invite, error) {
	if token == "" {
		return nil, nil
	}
	row, err := q.GetValidInviteByTokenHash(ctx, tokens.Hash(token))
	if err != nil {
		if db.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get invite: %w", err)
	}
	return &Invite{Row: row.Invite, WorkspaceName: row.WorkspaceName}, nil
}

// ErrInviteInvalid is returned for unknown, used, expired or mismatched invites.
var ErrInviteInvalid = apperr.Forbidden("This invite is invalid or has expired.")
