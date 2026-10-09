// Package pages implements the page tree: create, read, rename, move, duplicate, archive/restore/
// purge, favorites, sharing (permission grants) and collab tokens. Every access decision goes
// through internal/perm.
package pages

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"roci.dev/fracdex"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
)

// Service holds the page use cases.
type Service struct {
	pool   *pgxpool.Pool
	q      *sqlcgen.Queries
	broker *events.Broker
	collab collabclient.Disconnecter
	log    *slog.Logger
	now    func() time.Time

	collabSecret    []byte
	collabPublicURL string
}

// Options configure NewService.
type Options struct {
	Pool            *pgxpool.Pool
	Broker          *events.Broker
	Collab          collabclient.Disconnecter
	Log             *slog.Logger
	Now             func() time.Time
	CollabSecret    string
	CollabPublicURL string
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Collab == nil {
		o.Collab = collabclient.Noop{}
	}
	return &Service{
		pool: o.Pool, q: sqlcgen.New(o.Pool), broker: o.Broker, collab: o.Collab, log: o.Log, now: o.Now,
		collabSecret: []byte(o.CollabSecret), collabPublicURL: o.CollabPublicURL,
	}
}

// ToSummary converts a page row plus the caller's role to the API shape. parentVisible=false hides
// the parent id (the caller cannot see the parent, so it must not learn its id).
func ToSummary(p sqlcgen.Page, role perm.Role, parentVisible bool) gen.PageSummary {
	s := gen.PageSummary{
		Id: p.ID, WorkspaceId: p.WorkspaceID, Title: p.Title, Icon: p.Icon, Cover: p.Cover,
		Position: p.Position, Visibility: gen.Visibility(p.Visibility), Role: gen.EffectiveRole(role.String()),
		CreatedBy: p.CreatedBy, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt, ArchivedAt: p.ArchivedAt,
	}
	if p.ParentID != nil && parentVisible {
		id := *p.ParentID
		s.ParentId = &id
	}
	return s
}

// summaryFor reads the caller's view of one page.
func summaryFor(ctx context.Context, q *sqlcgen.Queries, userID, pageID uuid.UUID) (gen.PageSummary, error) {
	row, err := q.GetPageSummary(ctx, sqlcgen.GetPageSummaryParams{ID: pageID, UserID: userID})
	if err != nil {
		if db.IsNotFound(err) {
			return gen.PageSummary{}, perm.ErrPageNotFound
		}
		return gen.PageSummary{}, fmt.Errorf("get page summary: %w", err)
	}
	return ToSummary(row.Page, perm.FromRank(row.RoleRank), row.ParentVisible), nil
}

// publish sends a page event; the broker fills in role/parentId per subscriber.
func (s *Service) publish(typ string, p sqlcgen.Page, actor uuid.UUID) {
	sum := ToSummary(p, perm.None, true)
	sum.Role = ""
	s.broker.Publish(events.Event{Type: typ, WorkspaceID: p.WorkspaceID, PageID: p.ID, ActorID: actor, Page: &sum})
}

func (s *Service) permissionsChanged(workspaceID, pageID, actor uuid.UUID) {
	s.broker.Publish(events.Event{
		Type: events.PermissionsChanged, WorkspaceID: workspaceID, PageID: pageID, ActorID: actor,
		Audience: events.AudienceAll,
	})
}

// closeSockets disconnects live collab connections of the given pages (best effort).
func (s *Service) closeSockets(pageIDs []uuid.UUID, reason string) {
	for _, id := range pageIDs {
		s.collab.Disconnect(collabclient.DisconnectRequest{PageID: id, Reason: reason})
	}
}

// ---------------------------------------------------------------- ordering

// positionFor computes the fractional index for a page placed among the children of parent.
// exclude is the page being moved (never its own neighbour). Without afterID/beforeID the page is
// appended.
func positionFor(ctx context.Context, q *sqlcgen.Queries, workspaceID uuid.UUID, parent *uuid.UUID, exclude uuid.UUID, afterID, beforeID *uuid.UUID) (string, error) {
	sibling := func(field string, id uuid.UUID) (string, error) {
		p, err := q.GetPage(ctx, id)
		if err != nil && !db.IsNotFound(err) {
			return "", fmt.Errorf("get sibling: %w", err)
		}
		if err != nil || p.WorkspaceID != workspaceID || p.ArchivedAt != nil || p.ID == exclude || !sameParent(p.ParentID, parent) {
			return "", apperr.FieldError(field, "Must be a sibling under the new parent.")
		}
		return p.Position, nil
	}
	optional := func(pos string, err error) (string, error) {
		if err != nil && db.IsNotFound(err) {
			return "", nil
		}
		return pos, err
	}

	switch {
	case afterID != nil && beforeID != nil:
		a, err := sibling("afterId", *afterID)
		if err != nil {
			return "", err
		}
		b, err := sibling("beforeId", *beforeID)
		if err != nil {
			return "", err
		}
		if a >= b {
			return "", apperr.FieldError("afterId", "afterId must come before beforeId.")
		}
		return between(a, b)
	case afterID != nil:
		a, err := sibling("afterId", *afterID)
		if err != nil {
			return "", err
		}
		next, err := optional(q.SiblingPositionAfter(ctx, sqlcgen.SiblingPositionAfterParams{
			WorkspaceID: workspaceID, ParentID: parent, ExcludeID: exclude, Pos: a,
		}))
		if err != nil {
			return "", fmt.Errorf("next sibling: %w", err)
		}
		return between(a, next)
	case beforeID != nil:
		b, err := sibling("beforeId", *beforeID)
		if err != nil {
			return "", err
		}
		prev, err := optional(q.SiblingPositionBefore(ctx, sqlcgen.SiblingPositionBeforeParams{
			WorkspaceID: workspaceID, ParentID: parent, ExcludeID: exclude, Pos: b,
		}))
		if err != nil {
			return "", fmt.Errorf("previous sibling: %w", err)
		}
		return between(prev, b)
	default:
		last, err := optional(q.LastSiblingPosition(ctx, sqlcgen.LastSiblingPositionParams{
			WorkspaceID: workspaceID, ParentID: parent, ExcludeID: exclude,
		}))
		if err != nil {
			return "", fmt.Errorf("last sibling: %w", err)
		}
		return between(last, "")
	}
}

func sameParent(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// between returns a fractional index strictly between a and b ("" = unbounded).
func between(a, b string) (string, error) {
	key, err := fracdex.KeyBetween(a, b)
	if err != nil {
		return "", fmt.Errorf("fractional index between %q and %q: %w", a, b, err)
	}
	return key, nil
}
