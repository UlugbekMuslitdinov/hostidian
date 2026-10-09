// Package auth implements accounts, sessions, invites-based registration, password management and
// the instance-admin operations (docs/conventions.md §2).
package auth

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/config"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/tokens"
	"hostidian/backend/internal/validate"
	"hostidian/backend/internal/workspaces"
)

const (
	// CookieName is the session cookie (conventions §2).
	CookieName = "hostidian_session"
	// SessionTTL is the sliding session lifetime.
	SessionTTL = 30 * 24 * time.Hour
	// touchInterval bounds how often last_seen_at / expires_at are written.
	touchInterval = 5 * time.Minute
	// ResetTTL is the validity of an admin-issued password-reset link.
	ResetTTL = 24 * time.Hour

	maxUserAgentLen = 512
)

// avatarPalette is where new accounts get their colour from.
var avatarPalette = []string{
	"#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
	"#eab308", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
}

// ClientMeta describes the caller of a login.
type ClientMeta struct {
	IP        string
	UserAgent string
}

// IssuedSession is a freshly created session; Token goes into the cookie and is never stored.
type IssuedSession struct {
	Token     string
	ID        uuid.UUID
	ExpiresAt time.Time
}

// Principal is the authenticated caller of a request.
type Principal struct {
	User      sqlcgen.User
	SessionID uuid.UUID
}

// Service is the auth use-case layer.
type Service struct {
	cfg     *config.Config
	pool    *pgxpool.Pool
	q       *sqlcgen.Queries
	broker  *events.Broker
	collab  collabclient.Disconnecter
	hasher  *Hasher
	limiter *Limiter
	log     *slog.Logger
	now     func() time.Time

	dummyHash string // verified against when the account does not exist, to equalise timing
}

// Options configure NewService.
type Options struct {
	Config  *config.Config
	Pool    *pgxpool.Pool
	Broker  *events.Broker
	Collab  collabclient.Disconnecter
	Hasher  *Hasher
	Limiter *Limiter
	Log     *slog.Logger
	Now     func() time.Time
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Hasher == nil {
		o.Hasher = NewHasher(HashParams{})
	}
	if o.Limiter == nil {
		o.Limiter = NewLimiter(10, 15*time.Minute, o.Now)
	}
	if o.Collab == nil {
		o.Collab = collabclient.Noop{}
	}
	s := &Service{
		cfg: o.Config, pool: o.Pool, q: sqlcgen.New(o.Pool), broker: o.Broker, collab: o.Collab,
		hasher: o.Hasher, limiter: o.Limiter, log: o.Log, now: o.Now,
	}
	s.dummyHash, _ = s.hasher.Hash("hostidian-timing-equaliser")
	return s
}

// Limiter exposes the limiter so the server can sweep it periodically.
func (s *Service) Limiter() *Limiter { return s.limiter }

// ---------------------------------------------------------------- sessions

func (s *Service) newSession(ctx context.Context, q *sqlcgen.Queries, userID uuid.UUID, meta ClientMeta) (IssuedSession, error) {
	token, err := tokens.New()
	if err != nil {
		return IssuedSession{}, err
	}
	ua := meta.UserAgent
	if len(ua) > maxUserAgentLen {
		ua = ua[:maxUserAgentLen]
	}
	expires := s.now().Add(SessionTTL)
	row, err := q.CreateSession(ctx, sqlcgen.CreateSessionParams{
		UserID: userID, TokenHash: tokens.Hash(token), UserAgent: ua, Ip: meta.IP, ExpiresAt: expires,
	})
	if err != nil {
		return IssuedSession{}, fmt.Errorf("create session: %w", err)
	}
	return IssuedSession{Token: token, ID: row.ID, ExpiresAt: expires}, nil
}

// Authenticate resolves a session cookie value. It returns (nil, nil, nil) for unknown, expired or
// disabled-user sessions. When it slid the expiry forward it also returns the new expiry so the
// caller can refresh the cookie.
func (s *Service) Authenticate(ctx context.Context, token string) (*Principal, *time.Time, error) {
	if token == "" {
		return nil, nil, nil
	}
	row, err := s.q.GetSessionByTokenHash(ctx, tokens.Hash(token))
	if err != nil {
		if db.IsNotFound(err) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("get session: %w", err)
	}
	p := &Principal{User: row.User, SessionID: row.Session.ID}
	now := s.now()
	if now.Sub(row.Session.LastSeenAt) < touchInterval {
		return p, nil, nil
	}
	expires := now.Add(SessionTTL)
	if err := s.q.TouchSession(ctx, sqlcgen.TouchSessionParams{ID: row.Session.ID, Now: now, ExpiresAt: expires}); err != nil {
		// Not fatal: the session is valid, we merely failed to extend it.
		s.log.Warn("touch session", "err", err)
		return p, nil, nil
	}
	return p, &expires, nil
}

// Logout deletes the session behind a cookie value (idempotent).
func (s *Service) Logout(ctx context.Context, p *Principal) error {
	if err := s.q.DeleteSessionByID(ctx, p.SessionID); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	s.broker.CloseSession(p.SessionID, "logged out")
	return nil
}

// ListSessions returns the caller's active sessions.
func (s *Service) ListSessions(ctx context.Context, p *Principal) ([]gen.Session, error) {
	rows, err := s.q.ListSessionsForUser(ctx, p.User.ID)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	out := make([]gen.Session, 0, len(rows))
	for _, r := range rows {
		out = append(out, gen.Session{
			Id: r.ID, UserAgent: r.UserAgent, Ip: r.Ip, CreatedAt: r.CreatedAt, LastSeenAt: r.LastSeenAt,
			Current: r.ID == p.SessionID,
		})
	}
	return out, nil
}

// RevokeSession deletes one of the caller's own sessions (404 for anybody else's).
func (s *Service) RevokeSession(ctx context.Context, p *Principal, sessionID uuid.UUID) error {
	n, err := s.q.DeleteSession(ctx, sqlcgen.DeleteSessionParams{ID: sessionID, UserID: p.User.ID})
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	if n == 0 {
		return apperr.NotFound("Session not found.")
	}
	s.broker.CloseSession(sessionID, "session revoked")
	return nil
}

// Cleanup is the periodic housekeeping job: it drops expired sessions and stale password-reset
// tokens and reports how many sessions were removed.
func (s *Service) Cleanup(ctx context.Context) (int64, error) {
	n, err := s.q.DeleteExpiredSessions(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	if err := s.q.DeleteStalePasswordResets(ctx); err != nil {
		return n, fmt.Errorf("delete stale password resets: %w", err)
	}
	return n, nil
}

// ---------------------------------------------------------------- Me / DTOs

// UserToGen converts a user row to the API shape.
func UserToGen(u sqlcgen.User) gen.User {
	return gen.User{
		Id: u.ID, Email: emailOf(u.Email), Name: u.Name, AvatarColor: u.AvatarColor,
		IsInstanceAdmin: u.IsInstanceAdmin, HasPassword: u.PasswordHash != nil, CreatedAt: u.CreatedAt,
	}
}

// Me returns the user and their workspace memberships.
func (s *Service) Me(ctx context.Context, u sqlcgen.User) (gen.Me, error) {
	return meFor(ctx, s.q, u)
}

func meFor(ctx context.Context, q *sqlcgen.Queries, u sqlcgen.User) (gen.Me, error) {
	rows, err := q.ListWorkspacesForUser(ctx, u.ID)
	if err != nil {
		return gen.Me{}, fmt.Errorf("list workspaces: %w", err)
	}
	ws := make([]gen.WorkspaceMembership, 0, len(rows))
	for _, r := range rows {
		ws = append(ws, workspaces.MembershipToGen(r.Workspace, r.Role))
	}
	return gen.Me{User: UserToGen(u), Workspaces: ws}, nil
}

// ---------------------------------------------------------------- instance info / setup

// InstanceInfo is the public bootstrap information.
func (s *Service) InstanceInfo(ctx context.Context) (gen.InstanceInfo, error) {
	settings, err := s.q.GetInstanceSettings(ctx)
	if err != nil {
		return gen.InstanceInfo{}, fmt.Errorf("get settings: %w", err)
	}
	n, err := s.q.CountUsers(ctx)
	if err != nil {
		return gen.InstanceInfo{}, fmt.Errorf("count users: %w", err)
	}
	info := gen.InstanceInfo{
		NeedsSetup: n == 0, InstanceName: settings.InstanceName, AllowOpenSignup: settings.AllowOpenSignup,
		Version: s.cfg.Version,
	}
	info.Oidc.Enabled = s.cfg.OIDC.Enabled()
	if info.Oidc.Enabled {
		name := s.cfg.OIDC.Name
		info.Oidc.Name = &name
	}
	return info, nil
}

// SetupInput is the body of POST /setup.
type SetupInput struct {
	Name          string
	Email         string
	Password      string
	WorkspaceName string
}

// Setup creates the first user (instance admin), their default workspace and a session.
func (s *Service) Setup(ctx context.Context, in SetupInput, meta ClientMeta) (gen.Me, IssuedSession, error) {
	name, email, err := validateIdentity(in.Name, in.Email, in.Password)
	if err != nil {
		return gen.Me{}, IssuedSession{}, err
	}
	wsName := strings.TrimSpace(in.WorkspaceName)
	if wsName == "" {
		wsName = "My Workspace"
	}
	if wsName, err = validate.Name("workspaceName", wsName); err != nil {
		return gen.Me{}, IssuedSession{}, err
	}
	hash, err := s.hasher.Hash(in.Password)
	if err != nil {
		return gen.Me{}, IssuedSession{}, err
	}

	type result struct {
		me   gen.Me
		sess IssuedSession
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (result, error) {
		if err := q.LockSetup(ctx); err != nil {
			return result{}, fmt.Errorf("lock setup: %w", err)
		}
		n, err := q.CountUsers(ctx)
		if err != nil {
			return result{}, fmt.Errorf("count users: %w", err)
		}
		if n > 0 {
			return result{}, apperr.Conflict("This instance has already been set up.")
		}
		user, err := q.CreateUser(ctx, sqlcgen.CreateUserParams{
			Email: email, Name: name, PasswordHash: &hash, AvatarColor: randomAvatarColor(), IsInstanceAdmin: true,
		})
		if err != nil {
			return result{}, fmt.Errorf("create admin: %w", err)
		}
		if _, err := workspaces.CreateWithOwner(ctx, q, user.ID, wsName, "", nil); err != nil {
			return result{}, err
		}
		sess, err := s.newSession(ctx, q, user.ID, meta)
		if err != nil {
			return result{}, err
		}
		me, err := meFor(ctx, q, user)
		return result{me, sess}, err
	})
	if err != nil {
		return gen.Me{}, IssuedSession{}, err
	}
	return res.me, res.sess, nil
}

// ---------------------------------------------------------------- login / register

func limitKey(ip, email string) string { return ip + "|" + strings.ToLower(email) }

// Login verifies credentials and opens a session. Failed attempts count against the
// per-(IP, email) limiter; a successful login resets it.
func (s *Service) Login(ctx context.Context, emailRaw, password string, meta ClientMeta) (gen.Me, IssuedSession, error) {
	email := strings.ToLower(strings.TrimSpace(emailRaw))
	key := limitKey(meta.IP, email)
	if !s.limiter.Allow(key) {
		return gen.Me{}, IssuedSession{}, apperr.RateLimited("Too many attempts. Try again in a few minutes.")
	}
	invalid := apperr.Unauthorized("Invalid email or password.")

	user, err := s.q.GetUserByEmail(ctx, email)
	if err != nil && !db.IsNotFound(err) {
		return gen.Me{}, IssuedSession{}, fmt.Errorf("get user: %w", err)
	}
	found := err == nil && user.PasswordHash != nil
	hash := s.dummyHash
	if found {
		hash = *user.PasswordHash
	}
	ok := s.hasher.Verify(password, hash)
	if !found || !ok {
		return gen.Me{}, IssuedSession{}, invalid
	}
	if user.DisabledAt != nil {
		return gen.Me{}, IssuedSession{}, apperr.Unauthorized("This account has been disabled.")
	}
	s.limiter.Reset(key)

	var sess IssuedSession
	if sess, err = s.newSession(ctx, s.q, user.ID, meta); err != nil {
		return gen.Me{}, IssuedSession{}, err
	}
	me, err := s.Me(ctx, user)
	return me, sess, err
}

// RegisterInput is the body of POST /auth/register.
type RegisterInput struct {
	Name        string
	Email       string
	Password    string
	InviteToken string
}

// Register creates an account: with a valid invite (which is consumed and grants membership), or
// without one when open signup is enabled.
func (s *Service) Register(ctx context.Context, in RegisterInput, meta ClientMeta) (gen.Me, IssuedSession, error) {
	name, email, err := validateIdentity(in.Name, in.Email, in.Password)
	if err != nil {
		return gen.Me{}, IssuedSession{}, err
	}
	if !s.limiter.Allow(limitKey(meta.IP, email)) {
		return gen.Me{}, IssuedSession{}, apperr.RateLimited("Too many attempts. Try again in a few minutes.")
	}
	hash, err := s.hasher.Hash(in.Password)
	if err != nil {
		return gen.Me{}, IssuedSession{}, err
	}

	type result struct {
		me     gen.Me
		sess   IssuedSession
		joined *workspaces.Invite
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (result, error) {
		invite, err := workspaces.LookupInvite(ctx, q, in.InviteToken)
		if err != nil {
			return result{}, err
		}
		if in.InviteToken != "" && invite == nil {
			return result{}, workspaces.ErrInviteInvalid
		}
		if invite == nil {
			settings, err := q.GetInstanceSettings(ctx)
			if err != nil {
				return result{}, fmt.Errorf("get settings: %w", err)
			}
			if !settings.AllowOpenSignup {
				return result{}, apperr.Forbidden("Registration is by invitation only.")
			}
		} else if invite.Row.Email != nil && !strings.EqualFold(*invite.Row.Email, email) {
			return result{}, apperr.Forbidden("This invite was issued for a different email address.")
		}

		user, err := q.CreateUser(ctx, sqlcgen.CreateUserParams{
			Email: email, Name: name, PasswordHash: &hash, AvatarColor: randomAvatarColor(),
		})
		if err != nil {
			if db.IsUniqueViolation(err) {
				return result{}, apperr.Conflict("An account with this email already exists.")
			}
			return result{}, fmt.Errorf("create user: %w", err)
		}
		if invite != nil {
			if err := acceptInvite(ctx, q, invite, user.ID); err != nil {
				return result{}, err
			}
		}
		sess, err := s.newSession(ctx, q, user.ID, meta)
		if err != nil {
			return result{}, err
		}
		me, err := meFor(ctx, q, user)
		return result{me: me, sess: sess, joined: invite}, err
	})
	if err != nil {
		return gen.Me{}, IssuedSession{}, err
	}
	s.announceJoin(res.joined, res.me.User.Id)
	return res.me, res.sess, nil
}

// announceJoin tells the workspace's clients that somebody joined through an invite.
func (s *Service) announceJoin(invite *workspaces.Invite, userID uuid.UUID) {
	if invite == nil {
		return
	}
	s.broker.Publish(events.Event{
		Type: events.MemberChanged, WorkspaceID: invite.Row.WorkspaceID, ActorID: userID,
		Data: map[string]any{"userId": userID, "role": invite.Row.Role, "removed": false},
	})
}

// acceptInvite consumes the invite and adds the membership. A user who is already a member keeps
// their (possibly higher) role and the invite stays unused.
func acceptInvite(ctx context.Context, q *sqlcgen.Queries, invite *workspaces.Invite, userID uuid.UUID) error {
	if _, ok, err := perm.MemberRole(ctx, q, invite.Row.WorkspaceID, userID); err != nil {
		return err
	} else if ok {
		return apperr.Conflict("You are already a member of this workspace.")
	}
	n, err := q.ConsumeInvite(ctx, sqlcgen.ConsumeInviteParams{ID: invite.Row.ID, UsedBy: &userID})
	if err != nil {
		return fmt.Errorf("consume invite: %w", err)
	}
	if n == 0 {
		return workspaces.ErrInviteInvalid // somebody else used it first
	}
	if err := q.AddWorkspaceMember(ctx, sqlcgen.AddWorkspaceMemberParams{
		WorkspaceID: invite.Row.WorkspaceID, UserID: userID, Role: invite.Row.Role,
	}); err != nil {
		return fmt.Errorf("add member: %w", err)
	}
	return nil
}

// InviteInfo is the public lookup behind the sign-up page.
func (s *Service) InviteInfo(ctx context.Context, token string) (gen.InviteInfo, error) {
	invite, err := workspaces.LookupInvite(ctx, s.q, token)
	if err != nil {
		return gen.InviteInfo{}, err
	}
	if invite == nil {
		return gen.InviteInfo{}, apperr.NotFound("Invite not found.")
	}
	return gen.InviteInfo{
		WorkspaceName: invite.WorkspaceName, Role: gen.InviteRole(invite.Row.Role), Email: invite.Row.Email,
	}, nil
}

// AcceptInvite lets a logged-in user join the invite's workspace.
func (s *Service) AcceptInvite(ctx context.Context, p *Principal, token string) (gen.Me, error) {
	invite, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (*workspaces.Invite, error) {
		invite, err := workspaces.LookupInvite(ctx, q, token)
		if err != nil {
			return nil, err
		}
		// An invite restricted to another email looks like a missing one.
		if invite == nil || (invite.Row.Email != nil && !strings.EqualFold(*invite.Row.Email, p.User.Email)) {
			return nil, apperr.NotFound("Invite not found.")
		}
		return invite, acceptInvite(ctx, q, invite, p.User.ID)
	})
	if err != nil {
		return gen.Me{}, err
	}
	s.announceJoin(invite, p.User.ID)
	return s.Me(ctx, p.User)
}

// ---------------------------------------------------------------- helpers

func validateIdentity(nameRaw, emailRaw, password string) (name, email string, err error) {
	if name, err = validate.Name("name", nameRaw); err != nil {
		return "", "", err
	}
	if email, err = validate.Email("email", emailRaw); err != nil {
		return "", "", err
	}
	if err = validate.Password("password", password); err != nil {
		return "", "", err
	}
	return name, email, nil
}

func randomAvatarColor() string {
	b := make([]byte, 1)
	if _, err := rand.Read(b); err != nil {
		return avatarPalette[0]
	}
	return avatarPalette[int(b[0])%len(avatarPalette)]
}
