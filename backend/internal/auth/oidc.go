package auth

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/oidc"
	"hostidian/backend/internal/validate"
	"hostidian/backend/internal/workspaces"
)

// ReasonAccountExists is reported when a concurrent signup created the same email first.
const ReasonAccountExists = "account_exists"

// OIDCLogin applies the account-linking policy (oidc.Decide) to a verified identity and, when it
// allows a login, opens a session. A non-empty reason means the login was refused and is meant for
// /login?error=<reason>.
func (s *Service) OIDCLogin(ctx context.Context, claims oidc.Claims, inviteToken string, meta ClientMeta) (sess IssuedSession, reason string, err error) {
	type result struct {
		sess   IssuedSession
		reason string
		userID uuid.UUID
		joined *workspaces.Invite
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (result, error) {
		settings, err := q.GetInstanceSettings(ctx)
		if err != nil {
			return result{}, fmt.Errorf("get settings: %w", err)
		}
		in := oidc.Input{Claims: claims, OpenSignup: settings.AllowOpenSignup}
		email := strings.ToLower(strings.TrimSpace(claims.Email))

		var identityUser, emailUser *sqlcgen.User
		identity, err := q.GetOIDCIdentity(ctx, sqlcgen.GetOIDCIdentityParams{Issuer: claims.Issuer, Subject: claims.Subject})
		switch {
		case err == nil:
			u, err := q.GetUserByID(ctx, identity.UserID)
			if err != nil {
				return result{}, fmt.Errorf("get identity user: %w", err)
			}
			identityUser = &u
			in.IdentityUser = &oidc.KnownUser{ID: u.ID, Disabled: u.DisabledAt != nil}
		case !db.IsNotFound(err):
			return result{}, fmt.Errorf("get oidc identity: %w", err)
		}
		if email != "" {
			u, err := q.GetUserByEmail(ctx, email)
			switch {
			case err == nil:
				emailUser = &u
				in.EmailUser = &oidc.KnownUser{ID: u.ID, Disabled: u.DisabledAt != nil}
			case !db.IsNotFound(err):
				return result{}, fmt.Errorf("get user by email: %w", err)
			}
		}
		invite, err := workspaces.LookupInvite(ctx, q, inviteToken)
		if err != nil {
			return result{}, err
		}
		if invite != nil {
			oi := &oidc.Invite{ID: invite.Row.ID}
			if invite.Row.Email != nil {
				oi.Email = strings.ToLower(*invite.Row.Email)
			}
			in.Invite = oi
		}

		decision := oidc.Decide(in)
		var userID uuid.UUID
		var joined *workspaces.Invite
		switch decision.Action {
		case oidc.Reject:
			return result{reason: decision.Reason}, nil
		case oidc.Login:
			userID = identityUser.ID
		case oidc.LinkAndLogin:
			userID = emailUser.ID
			if err := q.CreateOIDCIdentity(ctx, sqlcgen.CreateOIDCIdentityParams{
				UserID: userID, Issuer: claims.Issuer, Subject: claims.Subject, Email: &email,
			}); err != nil {
				return result{}, fmt.Errorf("link identity: %w", err)
			}
		case oidc.Create:
			user, err := q.CreateUser(ctx, sqlcgen.CreateUserParams{
				Email: email, Name: displayName(claims.Name, email), AvatarColor: randomAvatarColor(),
			})
			if err != nil {
				if db.IsUniqueViolation(err) {
					return result{reason: ReasonAccountExists}, nil
				}
				return result{}, fmt.Errorf("create oidc user: %w", err)
			}
			userID = user.ID
			if err := q.CreateOIDCIdentity(ctx, sqlcgen.CreateOIDCIdentityParams{
				UserID: userID, Issuer: claims.Issuer, Subject: claims.Subject, Email: &email,
			}); err != nil {
				return result{}, fmt.Errorf("create identity: %w", err)
			}
			if decision.UseInvite {
				if err := acceptInvite(ctx, q, invite, userID); err != nil {
					return result{}, err
				}
				joined = invite
			}
		}
		sess, err := s.newSession(ctx, q, userID, meta)
		return result{sess: sess, userID: userID, joined: joined}, err
	})
	if err != nil {
		return IssuedSession{}, "", err
	}
	s.announceJoin(res.joined, res.userID)
	return res.sess, res.reason, nil
}

// displayName picks a valid account name from the provider's claims.
func displayName(name, email string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	if utf8.RuneCountInString(name) > validate.MaxNameLen {
		name = string([]rune(name)[:validate.MaxNameLen])
	}
	if name == "" {
		name = "User"
	}
	return name
}
