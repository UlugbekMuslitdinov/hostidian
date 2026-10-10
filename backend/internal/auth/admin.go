package auth

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

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

// RequireInstanceAdmin rejects non-admins with 403.
func RequireInstanceAdmin(p *Principal) error {
	if !p.User.IsInstanceAdmin {
		return apperr.Forbidden("Only instance administrators can do this.")
	}
	return nil
}

// AdminListUsers lists every account of the instance.
func (s *Service) AdminListUsers(ctx context.Context, p *Principal) ([]gen.AdminUser, error) {
	if err := RequireInstanceAdmin(p); err != nil {
		return nil, err
	}
	return s.adminUsers(ctx, uuid.Nil)
}

// adminUsers builds the admin view of all users, or only of one when only != Nil.
func (s *Service) adminUsers(ctx context.Context, only uuid.UUID) ([]gen.AdminUser, error) {
	rows, err := s.q.ListUsersForAdmin(ctx)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	seen, err := s.q.ListUsersLastSeen(ctx)
	if err != nil {
		return nil, fmt.Errorf("list last seen: %w", err)
	}
	lastSeen := make(map[uuid.UUID]time.Time, len(seen))
	for _, r := range seen {
		lastSeen[r.UserID] = r.LastSeenAt
	}
	out := make([]gen.AdminUser, 0, len(rows))
	for _, r := range rows {
		if only != uuid.Nil && r.ID != only {
			continue
		}
		u := gen.AdminUser{
			Id: r.ID, Email: emailOf(r.Email), Name: r.Name, AvatarColor: r.AvatarColor,
			IsInstanceAdmin: r.IsInstanceAdmin, DisabledAt: r.DisabledAt, CreatedAt: r.CreatedAt,
			WorkspaceCount: int(r.WorkspaceCount),
		}
		if t, ok := lastSeen[r.ID]; ok {
			u.LastSeenAt = &t
		}
		out = append(out, u)
	}
	return out, nil
}

// AdminUpdateInput is the body of PATCH /admin/users/{userId}.
type AdminUpdateInput struct {
	Disabled        *bool
	IsInstanceAdmin *bool
}

// AdminUpdateUser disables/enables a user or changes the instance-admin flag. Admins cannot disable
// or demote themselves, and the last enabled admin can never be removed.
func (s *Service) AdminUpdateUser(ctx context.Context, p *Principal, targetID uuid.UUID, in AdminUpdateInput) (gen.AdminUser, error) {
	if err := RequireInstanceAdmin(p); err != nil {
		return gen.AdminUser{}, err
	}
	if targetID == p.User.ID {
		if in.Disabled != nil && *in.Disabled {
			return gen.AdminUser{}, apperr.Conflict("You cannot disable your own account.")
		}
		if in.IsInstanceAdmin != nil && !*in.IsInstanceAdmin {
			return gen.AdminUser{}, apperr.Conflict("You cannot remove your own administrator rights.")
		}
	}

	disabledNow := false
	err := db.InTx(ctx, s.pool, func(q *sqlcgen.Queries) error {
		admins, err := q.LockEnabledInstanceAdmins(ctx)
		if err != nil {
			return fmt.Errorf("lock admins: %w", err)
		}
		target, err := q.GetUserByID(ctx, targetID)
		if err != nil {
			if db.IsNotFound(err) {
				return apperr.NotFound("User not found.")
			}
			return fmt.Errorf("get user: %w", err)
		}
		targetIsEnabledAdmin := target.IsInstanceAdmin && target.DisabledAt == nil
		losesAdmin := targetIsEnabledAdmin &&
			((in.Disabled != nil && *in.Disabled) || (in.IsInstanceAdmin != nil && !*in.IsInstanceAdmin))
		if losesAdmin && len(admins) <= 1 {
			return apperr.Conflict("The instance needs at least one enabled administrator.")
		}
		updated, err := q.UpdateUserAdminFields(ctx, sqlcgen.UpdateUserAdminFieldsParams{
			ID: targetID, Disabled: in.Disabled, IsInstanceAdmin: in.IsInstanceAdmin,
		})
		if err != nil {
			return fmt.Errorf("update user: %w", err)
		}
		if updated.DisabledAt != nil && target.DisabledAt == nil {
			disabledNow = true
			if err := q.DeleteUserSessions(ctx, targetID); err != nil {
				return fmt.Errorf("revoke sessions: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return gen.AdminUser{}, err
	}
	if disabledNow {
		s.broker.CloseUser(targetID, uuid.Nil, "account disabled")
		s.collab.Disconnect(collabclient.DisconnectRequest{UserID: targetID, Reason: "user_disabled"})
	}
	users, err := s.adminUsers(ctx, targetID)
	if err != nil {
		return gen.AdminUser{}, err
	}
	if len(users) == 0 {
		return gen.AdminUser{}, apperr.NotFound("User not found.")
	}
	return users[0], nil
}

// CreateResetLink issues a 24 h single-use password-reset link for a user (admins only). The link
// is returned once; only its hash is stored.
func (s *Service) CreateResetLink(ctx context.Context, p *Principal, targetID uuid.UUID) (string, time.Time, error) {
	if err := RequireInstanceAdmin(p); err != nil {
		return "", time.Time{}, err
	}
	if _, err := s.q.GetUserByID(ctx, targetID); err != nil {
		if db.IsNotFound(err) {
			return "", time.Time{}, apperr.NotFound("User not found.")
		}
		return "", time.Time{}, fmt.Errorf("get user: %w", err)
	}
	token, err := tokens.New()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := s.now().Add(ResetTTL)
	if err := s.q.CreatePasswordReset(ctx, sqlcgen.CreatePasswordResetParams{
		TokenHash: tokens.Hash(token), UserID: targetID, CreatedBy: &p.User.ID, ExpiresAt: expires,
	}); err != nil {
		return "", time.Time{}, fmt.Errorf("create reset: %w", err)
	}
	return s.cfg.PublicURL + "/reset-password/" + token, expires, nil
}

// GetSettings returns the instance settings (admins only).
func (s *Service) GetSettings(ctx context.Context, p *Principal) (gen.InstanceSettings, error) {
	if err := RequireInstanceAdmin(p); err != nil {
		return gen.InstanceSettings{}, err
	}
	st, err := s.q.GetInstanceSettings(ctx)
	if err != nil {
		return gen.InstanceSettings{}, fmt.Errorf("get settings: %w", err)
	}
	return settingsToGen(st), nil
}

func settingsToGen(st sqlcgen.InstanceSetting) gen.InstanceSettings {
	return gen.InstanceSettings{
		InstanceName: st.InstanceName, AllowOpenSignup: st.AllowOpenSignup, AllowWorkspaceCreation: st.AllowWorkspaceCreation,
	}
}

// SettingsInput is the body of PATCH /admin/settings.
type SettingsInput struct {
	InstanceName           *string
	AllowOpenSignup        *bool
	AllowWorkspaceCreation *bool
}

// UpdateSettings changes instance settings (admins only).
func (s *Service) UpdateSettings(ctx context.Context, p *Principal, in SettingsInput) (gen.InstanceSettings, error) {
	if err := RequireInstanceAdmin(p); err != nil {
		return gen.InstanceSettings{}, err
	}
	params := sqlcgen.UpdateInstanceSettingsParams{AllowOpenSignup: in.AllowOpenSignup, AllowWorkspaceCreation: in.AllowWorkspaceCreation}
	if in.InstanceName != nil {
		name, err := validate.Name("instanceName", *in.InstanceName)
		if err != nil {
			return gen.InstanceSettings{}, err
		}
		params.InstanceName = &name
	}
	st, err := s.q.UpdateInstanceSettings(ctx, params)
	if err != nil {
		return gen.InstanceSettings{}, fmt.Errorf("update settings: %w", err)
	}
	return settingsToGen(st), nil
}

// NewAccountLinkTTL is the validity of the set-password link of an account created without a password.
const NewAccountLinkTTL = 7 * 24 * time.Hour

// AdminMembership places a new account into a workspace.
type AdminMembership struct {
	WorkspaceID uuid.UUID
	Role        string
}

// AdminCreateUserInput is the body of POST /admin/users.
type AdminCreateUserInput struct {
	Name            string
	Email           string
	Password        *string
	IsInstanceAdmin bool
	Memberships     []AdminMembership
}

// AdminCreateUser creates an account on behalf of an instance admin. With a password the account can
// sign in right away; without one the response carries a single-use set-password link. Memberships may
// only target workspaces in which the caller is owner/admin (and only owners may grant admin), so this
// cannot be used to reach into a workspace the admin has no standing in.
func (s *Service) AdminCreateUser(ctx context.Context, p *Principal, in AdminCreateUserInput) (gen.AdminCreatedUser, error) {
	if err := RequireInstanceAdmin(p); err != nil {
		return gen.AdminCreatedUser{}, err
	}
	name, err := validate.Name("name", in.Name)
	if err != nil {
		return gen.AdminCreatedUser{}, err
	}
	email, err := validate.Email("email", in.Email)
	if err != nil {
		return gen.AdminCreatedUser{}, err
	}
	var hash *string
	if in.Password != nil && strings.TrimSpace(*in.Password) != "" {
		if err := validate.Password("password", *in.Password); err != nil {
			return gen.AdminCreatedUser{}, err
		}
		h, err := s.hasher.Hash(*in.Password)
		if err != nil {
			return gen.AdminCreatedUser{}, fmt.Errorf("hash password: %w", err)
		}
		hash = &h
	}
	seen := map[uuid.UUID]bool{}
	for _, m := range in.Memberships {
		switch perm.WorkspaceRole(m.Role) {
		case perm.Admin, perm.Member, perm.Guest:
		default:
			return gen.AdminCreatedUser{}, apperr.FieldError("memberships", "Role must be admin, member or guest.")
		}
		if seen[m.WorkspaceID] {
			return gen.AdminCreatedUser{}, apperr.FieldError("memberships", "A workspace can only be listed once.")
		}
		seen[m.WorkspaceID] = true
	}

	type result struct {
		userID  uuid.UUID
		link    string
		expires time.Time
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (result, error) {
		for _, m := range in.Memberships {
			actorRole, err := perm.RequireWorkspaceAdmin(ctx, q, m.WorkspaceID, p.User.ID)
			if err != nil {
				return result{}, err
			}
			if perm.WorkspaceRole(m.Role) == perm.Admin && actorRole != perm.Owner {
				return result{}, apperr.Forbidden("Only workspace owners can add admins.")
			}
		}
		user, err := q.CreateUser(ctx, sqlcgen.CreateUserParams{
			Email: email, Name: name, PasswordHash: hash, AvatarColor: randomAvatarColor(),
			IsInstanceAdmin: in.IsInstanceAdmin,
		})
		if err != nil {
			if db.IsUniqueViolation(err) {
				return result{}, apperr.Conflict("An account with this email already exists.")
			}
			return result{}, fmt.Errorf("create user: %w", err)
		}
		for _, m := range in.Memberships {
			if err := q.AddWorkspaceMember(ctx, sqlcgen.AddWorkspaceMemberParams{
				WorkspaceID: m.WorkspaceID, UserID: user.ID, Role: m.Role,
			}); err != nil {
				return result{}, fmt.Errorf("add membership: %w", err)
			}
		}
		out := result{userID: user.ID}
		if hash == nil {
			token, err := tokens.New()
			if err != nil {
				return result{}, err
			}
			out.expires = s.now().Add(NewAccountLinkTTL)
			if err := q.CreatePasswordReset(ctx, sqlcgen.CreatePasswordResetParams{
				TokenHash: tokens.Hash(token), UserID: user.ID, CreatedBy: &p.User.ID, ExpiresAt: out.expires,
			}); err != nil {
				return result{}, fmt.Errorf("create set-password link: %w", err)
			}
			out.link = s.cfg.PublicURL + "/reset-password/" + token
		}
		return out, nil
	})
	if err != nil {
		return gen.AdminCreatedUser{}, err
	}
	for _, m := range in.Memberships {
		s.broker.Publish(events.Event{
			Type: events.MemberChanged, WorkspaceID: m.WorkspaceID, ActorID: p.User.ID,
			Data: map[string]any{"userId": res.userID, "role": m.Role, "removed": false},
		})
	}
	users, err := s.adminUsers(ctx, res.userID)
	if err != nil || len(users) != 1 {
		return gen.AdminCreatedUser{}, fmt.Errorf("load created user: %w", err)
	}
	out := gen.AdminCreatedUser{User: users[0]}
	if res.link != "" {
		out.SetPasswordUrl = &res.link
		exp := res.expires.UTC()
		out.SetPasswordExpiresAt = &exp
	}
	return out, nil
}
