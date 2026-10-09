package auth

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/tokens"
	"hostidian/backend/internal/validate"
)

// ProfileInput is the body of PATCH /auth/profile (nil fields stay unchanged).
type ProfileInput struct {
	Name        *string
	AvatarColor *string
}

// UpdateProfile changes the caller's display name and/or avatar colour.
func (s *Service) UpdateProfile(ctx context.Context, p *Principal, in ProfileInput) (gen.User, error) {
	params := sqlcgen.UpdateUserProfileParams{ID: p.User.ID}
	if in.Name != nil {
		name, err := validate.Name("name", *in.Name)
		if err != nil {
			return gen.User{}, err
		}
		params.Name = &name
	}
	if in.AvatarColor != nil {
		if err := validate.AvatarColor("avatarColor", *in.AvatarColor); err != nil {
			return gen.User{}, err
		}
		params.AvatarColor = in.AvatarColor
	}
	u, err := s.q.UpdateUserProfile(ctx, params)
	if err != nil {
		return gen.User{}, fmt.Errorf("update profile: %w", err)
	}
	return UserToGen(u), nil
}

// ChangePassword sets a new password. The current password is required unless the account has none
// yet (OIDC-only). All other sessions are revoked.
func (s *Service) ChangePassword(ctx context.Context, p *Principal, current, next string) error {
	if err := validate.Password("newPassword", next); err != nil {
		return err
	}
	if p.User.PasswordHash != nil {
		if current == "" {
			return apperr.FieldError("currentPassword", "Enter your current password.")
		}
		if !s.hasher.Verify(current, *p.User.PasswordHash) {
			return apperr.FieldError("currentPassword", "The current password is incorrect.")
		}
	}
	hash, err := s.hasher.Hash(next)
	if err != nil {
		return err
	}
	err = db.InTx(ctx, s.pool, func(q *sqlcgen.Queries) error {
		if err := q.SetUserPassword(ctx, sqlcgen.SetUserPasswordParams{ID: p.User.ID, PasswordHash: &hash}); err != nil {
			return fmt.Errorf("set password: %w", err)
		}
		return q.DeleteUserSessionsExcept(ctx, sqlcgen.DeleteUserSessionsExceptParams{UserID: p.User.ID, KeepID: p.SessionID})
	})
	if err != nil {
		return err
	}
	s.broker.CloseUser(p.User.ID, p.SessionID, "password changed")
	return nil
}

// ConfirmPasswordReset consumes an admin-issued reset token, sets the password and revokes every
// session of the user. Attempts are rate limited per IP.
func (s *Service) ConfirmPasswordReset(ctx context.Context, token, newPassword string, meta ClientMeta) error {
	if !s.limiter.Allow(limitKey(meta.IP, "password-reset")) {
		return apperr.RateLimited("Too many attempts. Try again in a few minutes.")
	}
	if err := validate.Password("newPassword", newPassword); err != nil {
		return err
	}
	hash, err := s.hasher.Hash(newPassword)
	if err != nil {
		return err
	}
	userID, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (uuid.UUID, error) {
		id, err := q.ConsumePasswordReset(ctx, tokens.Hash(token))
		if err != nil {
			if db.IsNotFound(err) {
				return uuid.Nil, apperr.NotFound("This reset link is invalid or has expired.")
			}
			return uuid.Nil, fmt.Errorf("consume reset: %w", err)
		}
		if err := q.SetUserPassword(ctx, sqlcgen.SetUserPasswordParams{ID: id, PasswordHash: &hash}); err != nil {
			return uuid.Nil, fmt.Errorf("set password: %w", err)
		}
		if err := q.DeleteUserSessions(ctx, id); err != nil {
			return uuid.Nil, fmt.Errorf("revoke sessions: %w", err)
		}
		return id, nil
	})
	if err != nil {
		return err
	}
	s.broker.CloseUser(userID, uuid.Nil, "password reset")
	return nil
}
