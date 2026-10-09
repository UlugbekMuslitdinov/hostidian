package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/httpapi/gen"
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
