package pages

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/validate"
)

// buildPermissions renders the explicit grants (own + inherited) and the governing visibility.
func buildPermissions(ctx context.Context, q *sqlcgen.Queries, pageID uuid.UUID) (gen.PagePermissions, error) {
	page, err := q.GetPage(ctx, pageID)
	if err != nil {
		return gen.PagePermissions{}, fmt.Errorf("get page: %w", err)
	}
	root, err := q.GetRootPage(ctx, pageID)
	if err != nil {
		return gen.PagePermissions{}, fmt.Errorf("get root: %w", err)
	}
	grants, err := q.ListEffectiveGrants(ctx, pageID)
	if err != nil {
		return gen.PagePermissions{}, fmt.Errorf("list grants: %w", err)
	}
	sort.Slice(grants, func(i, j int) bool {
		if (grants[i].GrantedOn == pageID) != (grants[j].GrantedOn == pageID) {
			return grants[i].GrantedOn == pageID // direct grants first
		}
		if a, b := strings.ToLower(grants[i].Name), strings.ToLower(grants[j].Name); a != b {
			return a < b
		}
		return grants[i].UserID.String() < grants[j].UserID.String()
	})
	out := gen.PagePermissions{
		Visibility:          gen.Visibility(root.Visibility),
		CanChangeVisibility: page.ParentID == nil,
		Entries:             make([]gen.PermissionEntry, 0, len(grants)),
	}
	for _, g := range grants {
		entry := gen.PermissionEntry{
			User: gen.MemberUser{Id: g.UserID, Name: g.Name, Email: openapi_types.Email(g.Email), AvatarColor: g.AvatarColor},
			Role: gen.PageRole(g.Role),
		}
		if g.GrantedOn != pageID {
			from := g.GrantedOn
			entry.InheritedFrom = &from
		}
		out.Entries = append(out.Entries, entry)
	}
	return out, nil
}

// Permissions lists the page's grants and visibility (needs full).
func (s *Service) Permissions(ctx context.Context, userID, pageID uuid.UUID) (gen.PagePermissions, error) {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.Full); err != nil {
		return gen.PagePermissions{}, err
	}
	return buildPermissions(ctx, s.q, pageID)
}

// GrantInput identifies the grantee by id or email.
type GrantInput struct {
	UserID *uuid.UUID
	Email  *string
	Role   string
}

// Grant gives (or changes) a user's explicit role on a page (needs full). A user of the instance
// who is not in the workspace is added as a guest. Nobody can be granted more than the granter has.
func (s *Service) Grant(ctx context.Context, actorID, pageID uuid.UUID, in GrantInput) (gen.PagePermissions, error) {
	role, ok := perm.ParseRole(in.Role)
	if !ok {
		return gen.PagePermissions{}, apperr.FieldError("role", "Role must be view, comment, edit or full.")
	}
	acc, err := perm.Require(ctx, s.q, actorID, pageID, perm.Full)
	if err != nil {
		return gen.PagePermissions{}, err
	}
	if role > acc.Role {
		return gen.PagePermissions{}, apperr.Forbidden("You cannot grant more access than you have.")
	}

	var target sqlcgen.User
	switch {
	case in.UserID != nil:
		target, err = s.q.GetUserByID(ctx, *in.UserID)
	case in.Email != nil:
		var email string
		if email, err = validate.Email("email", *in.Email); err != nil {
			return gen.PagePermissions{}, err
		}
		target, err = s.q.GetUserByEmail(ctx, email)
	default:
		return gen.PagePermissions{}, apperr.Validation("Provide userId or email.", map[string]string{"userId": "Provide userId or email."})
	}
	if err != nil {
		if db.IsNotFound(err) {
			return gen.PagePermissions{}, apperr.NotFound("User not found.")
		}
		return gen.PagePermissions{}, fmt.Errorf("find user: %w", err)
	}
	if target.DisabledAt != nil {
		return gen.PagePermissions{}, apperr.NotFound("User not found.")
	}

	before, err := perm.Resolve(ctx, s.q, target.ID, pageID)
	if err != nil {
		return gen.PagePermissions{}, err
	}
	addedAsGuest := false
	err = db.InTx(ctx, s.pool, func(q *sqlcgen.Queries) error {
		n, err := q.AddWorkspaceMemberIfMissing(ctx, sqlcgen.AddWorkspaceMemberIfMissingParams{
			WorkspaceID: acc.WorkspaceID, UserID: target.ID, Role: string(perm.Guest),
		})
		if err != nil {
			return fmt.Errorf("add guest: %w", err)
		}
		addedAsGuest = n > 0
		return q.UpsertPagePermission(ctx, sqlcgen.UpsertPagePermissionParams{
			PageID: pageID, UserID: target.ID, Role: role.String(), GrantedBy: &actorID,
		})
	})
	if err != nil {
		return gen.PagePermissions{}, err
	}
	s.afterGrantChange(ctx, acc.WorkspaceID, pageID, actorID, target.ID, before.Role)
	if addedAsGuest {
		s.broker.Publish(events.Event{
			Type: events.MemberChanged, WorkspaceID: acc.WorkspaceID, ActorID: actorID,
			Data: map[string]any{"userId": target.ID, "role": string(perm.Guest), "removed": false},
		})
	}
	return buildPermissions(ctx, s.q, pageID)
}

// Revoke removes the explicit grant of a user on this page (needs full).
func (s *Service) Revoke(ctx context.Context, actorID, pageID, targetID uuid.UUID) (gen.PagePermissions, error) {
	acc, err := perm.Require(ctx, s.q, actorID, pageID, perm.Full)
	if err != nil {
		return gen.PagePermissions{}, err
	}
	before, err := perm.Resolve(ctx, s.q, targetID, pageID)
	if err != nil {
		return gen.PagePermissions{}, err
	}
	n, err := s.q.DeletePagePermission(ctx, sqlcgen.DeletePagePermissionParams{PageID: pageID, UserID: targetID})
	if err != nil {
		return gen.PagePermissions{}, fmt.Errorf("delete permission: %w", err)
	}
	if n == 0 {
		return gen.PagePermissions{}, apperr.NotFound("There is no permission set on this page for that user.")
	}
	s.afterGrantChange(ctx, acc.WorkspaceID, pageID, actorID, targetID, before.Role)
	return buildPermissions(ctx, s.q, pageID)
}

// afterGrantChange re-evaluates the affected user's access: if it changed, their live collab
// sockets are closed so the next token carries the new role (or a 404), and everybody refetches.
func (s *Service) afterGrantChange(ctx context.Context, workspaceID, pageID, actorID, targetID uuid.UUID, before perm.Role) {
	after, err := perm.Resolve(ctx, s.q, targetID, pageID)
	if err != nil {
		s.log.Warn("re-resolve after grant change", "err", err)
	}
	if err != nil || after.Role != before {
		s.collab.Disconnect(collabclient.DisconnectRequest{UserID: targetID, Reason: "permissions_changed"})
	}
	s.permissionsChanged(workspaceID, pageID, actorID)
}

// SetVisibility switches a root page between workspace and private (needs full).
func (s *Service) SetVisibility(ctx context.Context, actorID, pageID uuid.UUID, visibility string) (gen.PagePermissions, error) {
	if visibility != visibilityWorkspace && visibility != visibilityPrivate {
		return gen.PagePermissions{}, apperr.FieldError("visibility", "Must be workspace or private.")
	}
	acc, err := perm.Require(ctx, s.q, actorID, pageID, perm.Full)
	if err != nil {
		return gen.PagePermissions{}, err
	}
	if acc.ParentID != nil {
		return gen.PagePermissions{}, apperr.FieldError("visibility", "Visibility can only be set on top-level pages.")
	}
	page, err := s.q.GetPage(ctx, pageID)
	if err != nil {
		return gen.PagePermissions{}, fmt.Errorf("get page: %w", err)
	}
	if page.Visibility != visibility {
		if _, err := s.q.SetPageVisibility(ctx, sqlcgen.SetPageVisibilityParams{ID: pageID, Visibility: visibility}); err != nil {
			return gen.PagePermissions{}, fmt.Errorf("set visibility: %w", err)
		}
		if ids, err := s.q.ListSubtreeIDs(ctx, pageID); err == nil {
			s.closeSockets(ids, "permissions_changed")
		}
		s.permissionsChanged(acc.WorkspaceID, pageID, actorID)
	}
	return buildPermissions(ctx, s.q, pageID)
}

// ---------------------------------------------------------------- collab token

const (
	collabTokenTTL = 120 * time.Second
	collabIssuer   = "hostidian-api"
	collabAudience = "hostidian-collab"
)

// CollabToken issues the short-lived JWT for the collaboration WebSocket (conventions §6).
func (s *Service) CollabToken(ctx context.Context, userID, pageID uuid.UUID) (gen.CollabToken, error) {
	acc, err := perm.Require(ctx, s.q, userID, pageID, perm.View)
	if err != nil {
		return gen.CollabToken{}, err
	}
	user, err := s.q.GetUserByID(ctx, userID)
	if err != nil {
		return gen.CollabToken{}, fmt.Errorf("get user: %w", err)
	}
	now := s.now().UTC()
	expires := now.Add(collabTokenTTL)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"iss":    collabIssuer,
		"aud":    collabAudience,
		"sub":    userID.String(),
		"pageId": pageID.String(),
		"role":   acc.Role.String(),
		"name":   user.Name,
		"color":  user.AvatarColor,
		"iat":    now.Unix(),
		"exp":    expires.Unix(),
	})
	signed, err := token.SignedString(s.collabSecret)
	if err != nil {
		return gen.CollabToken{}, fmt.Errorf("sign collab token: %w", err)
	}
	return gen.CollabToken{
		Token:        signed,
		ExpiresAt:    expires,
		Role:         gen.EffectiveRole(acc.Role.String()),
		WsUrl:        s.collabPublicURL,
		DocumentName: "page:" + pageID.String(),
	}, nil
}
