package pages

import (
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/validate"
)

const (
	visibilityWorkspace = "workspace"
	visibilityPrivate   = "private"
	copySuffix          = " (copy)"
)

// ---------------------------------------------------------------- lists

// List returns every non-archived page the caller can view (flat; the client builds the tree).
func (s *Service) List(ctx context.Context, userID, workspaceID uuid.UUID) ([]gen.PageSummary, error) {
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return nil, err
	}
	rows, err := s.q.ListVisiblePages(ctx, sqlcgen.ListVisiblePagesParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("list pages: %w", err)
	}
	out := make([]gen.PageSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, ToSummary(r.Page, perm.FromRank(r.RoleRank), r.ParentVisible))
	}
	return out, nil
}

// Recent returns the most recently updated visible pages.
func (s *Service) Recent(ctx context.Context, userID, workspaceID uuid.UUID, limit int) ([]gen.PageSummary, error) {
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 50 {
		return nil, apperr.BadRequest("limit must be between 1 and 50.")
	}
	rows, err := s.q.ListRecentPages(ctx, sqlcgen.ListRecentPagesParams{WorkspaceID: workspaceID, UserID: userID, MaxRows: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list recent: %w", err)
	}
	out := make([]gen.PageSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, ToSummary(r.Page, perm.FromRank(r.RoleRank), r.ParentVisible))
	}
	return out, nil
}

// Favorites returns the caller's favorite pages (visible, non-archived).
func (s *Service) Favorites(ctx context.Context, userID, workspaceID uuid.UUID) ([]gen.PageSummary, error) {
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return nil, err
	}
	rows, err := s.q.ListFavoritePages(ctx, sqlcgen.ListFavoritePagesParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("list favorites: %w", err)
	}
	out := make([]gen.PageSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, ToSummary(r.Page, perm.FromRank(r.RoleRank), r.ParentVisible))
	}
	return out, nil
}

// Trash returns archived subtree roots the caller has full access to.
func (s *Service) Trash(ctx context.Context, userID, workspaceID uuid.UUID) ([]gen.PageSummary, error) {
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return nil, err
	}
	rows, err := s.q.ListTrash(ctx, sqlcgen.ListTrashParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("list trash: %w", err)
	}
	out := make([]gen.PageSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, ToSummary(r.Page, perm.FromRank(r.RoleRank), r.ParentVisible))
	}
	return out, nil
}

// ---------------------------------------------------------------- create

// CreateInput is the body of POST /workspaces/{id}/pages.
type CreateInput struct {
	ID         *uuid.UUID
	ParentID   *uuid.UUID
	Title      string
	Icon       *string
	Visibility *string
	AfterID    *uuid.UUID
	BeforeID   *uuid.UUID
}

// Create makes a page. With a client-supplied id the call is idempotent: repeating it as the same
// creator returns the existing page (created=false).
func (s *Service) Create(ctx context.Context, userID, workspaceID uuid.UUID, in CreateInput) (page gen.PageSummary, created bool, err error) {
	wsRole, err := perm.RequireMember(ctx, s.q, workspaceID, userID)
	if err != nil {
		return gen.PageSummary{}, false, err
	}
	if err := validate.Title("title", in.Title); err != nil {
		return gen.PageSummary{}, false, err
	}
	if in.Icon != nil {
		if err := validate.ShortString("icon", *in.Icon, 64); err != nil {
			return gen.PageSummary{}, false, err
		}
	}
	visibility := visibilityWorkspace
	if in.Visibility != nil {
		switch *in.Visibility {
		case visibilityWorkspace, visibilityPrivate:
			visibility = *in.Visibility
		default:
			return gen.PageSummary{}, false, apperr.FieldError("visibility", "Must be workspace or private.")
		}
	}
	if in.ParentID != nil && visibility == visibilityPrivate {
		return gen.PageSummary{}, false, apperr.FieldError("visibility", "Only top-level pages can be private.")
	}

	id := uuid.Nil
	if in.ID != nil {
		if *in.ID == uuid.Nil {
			return gen.PageSummary{}, false, apperr.FieldError("id", "Must be a valid UUID.")
		}
		id = *in.ID
		if existing, ok, err := s.existingForRetry(ctx, id, userID, workspaceID); err != nil || ok {
			return existing, false, err
		}
	} else if id, err = uuid.NewV7(); err != nil {
		return gen.PageSummary{}, false, fmt.Errorf("new page id: %w", err)
	}

	row, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (sqlcgen.Page, error) {
		if in.ParentID != nil {
			parent, err := perm.Require(ctx, q, userID, *in.ParentID, perm.Edit)
			if err != nil {
				return sqlcgen.Page{}, err
			}
			if parent.WorkspaceID != workspaceID {
				return sqlcgen.Page{}, perm.ErrPageNotFound
			}
		} else if !wsRole.CanCreateRootPages() {
			return sqlcgen.Page{}, apperr.Forbidden("Guests can only create pages inside pages shared with them.")
		}
		position, err := positionFor(ctx, q, workspaceID, in.ParentID, uuid.Nil, in.AfterID, in.BeforeID)
		if err != nil {
			return sqlcgen.Page{}, err
		}
		return q.InsertPage(ctx, sqlcgen.InsertPageParams{
			ID: id, WorkspaceID: workspaceID, ParentID: in.ParentID, Title: in.Title, Icon: in.Icon,
			Position: position, Visibility: visibility, CreatedBy: userID,
		})
	})
	if err != nil {
		if in.ID != nil && db.IsUniqueViolation(err) {
			// Lost a race against a concurrent retry of the same request.
			if existing, ok, err2 := s.existingForRetry(ctx, id, userID, workspaceID); err2 != nil || ok {
				return existing, false, err2
			}
		}
		if db.IsUniqueViolation(err) {
			return gen.PageSummary{}, false, apperr.Conflict("A page with this id already exists.")
		}
		return gen.PageSummary{}, false, err
	}
	s.publish(events.PageCreated, row, userID)
	sum, err := summaryFor(ctx, s.q, userID, row.ID)
	return sum, true, err
}

// existingForRetry implements the idempotent-create rule: the same id by the same creator in the
// same workspace returns the existing page; any other collision is a 409.
func (s *Service) existingForRetry(ctx context.Context, id, userID, workspaceID uuid.UUID) (gen.PageSummary, bool, error) {
	p, err := s.q.GetPage(ctx, id)
	if err != nil {
		if db.IsNotFound(err) {
			return gen.PageSummary{}, false, nil
		}
		return gen.PageSummary{}, false, fmt.Errorf("get page: %w", err)
	}
	if p.CreatedBy != userID || p.WorkspaceID != workspaceID {
		return gen.PageSummary{}, false, apperr.Conflict("A page with this id already exists.")
	}
	sum, err := summaryFor(ctx, s.q, userID, id)
	if err != nil {
		if perm.IsNotFound(err) {
			return gen.PageSummary{}, false, apperr.Conflict("A page with this id already exists.")
		}
		return gen.PageSummary{}, false, err
	}
	return sum, true, nil
}

// ---------------------------------------------------------------- read / update

// Get returns a page with its breadcrumbs. Archived pages are readable by users with full access
// (trash preview) and answer 404 to everybody else.
func (s *Service) Get(ctx context.Context, userID, pageID uuid.UUID) (gen.PageDetail, error) {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.View, perm.AllowArchived()); err != nil {
		return gen.PageDetail{}, err
	}
	row, err := s.q.GetPageSummary(ctx, sqlcgen.GetPageSummaryParams{ID: pageID, UserID: userID})
	if err != nil {
		if db.IsNotFound(err) {
			return gen.PageDetail{}, perm.ErrPageNotFound
		}
		return gen.PageDetail{}, fmt.Errorf("get page: %w", err)
	}
	crumbs, err := s.q.ListVisibleAncestors(ctx, sqlcgen.ListVisibleAncestorsParams{PageID: pageID, UserID: userID})
	if err != nil {
		return gen.PageDetail{}, fmt.Errorf("breadcrumbs: %w", err)
	}
	fav, err := s.q.IsFavorite(ctx, sqlcgen.IsFavoriteParams{UserID: userID, PageID: pageID})
	if err != nil {
		return gen.PageDetail{}, fmt.Errorf("is favorite: %w", err)
	}
	detail := gen.PageDetail{
		Page:        ToSummary(row.Page, perm.FromRank(row.RoleRank), row.ParentVisible),
		Breadcrumbs: make([]gen.PageRef, 0, len(crumbs)),
		IsFavorite:  fav,
	}
	for _, c := range crumbs {
		detail.Breadcrumbs = append(detail.Breadcrumbs, gen.PageRef{Id: c.ID, Title: c.Title, Icon: c.Icon})
	}
	if row.Page.LastEditedBy != nil {
		u, err := s.q.GetUserByID(ctx, *row.Page.LastEditedBy)
		if err != nil && !db.IsNotFound(err) {
			return gen.PageDetail{}, fmt.Errorf("get editor: %w", err)
		}
		if err == nil {
			detail.LastEditedBy = &gen.UserRef{Id: u.ID, Name: u.Name, AvatarColor: u.AvatarColor}
		}
	}
	return detail, nil
}

// UpdateInput is the body of PATCH /pages/{id}; Set* flags mark fields that were present (so an
// explicit null can clear icon/cover).
type UpdateInput struct {
	Title    *string
	SetIcon  bool
	Icon     *string
	SetCover bool
	Cover    *string
}

// Update changes title/icon/cover (needs edit).
func (s *Service) Update(ctx context.Context, userID, pageID uuid.UUID, in UpdateInput) (gen.PageSummary, error) {
	if in.Title != nil {
		if err := validate.Title("title", *in.Title); err != nil {
			return gen.PageSummary{}, err
		}
	}
	if in.SetIcon && in.Icon != nil {
		if err := validate.ShortString("icon", *in.Icon, 64); err != nil {
			return gen.PageSummary{}, err
		}
	}
	if in.SetCover && in.Cover != nil {
		if err := validate.ShortString("cover", *in.Cover, 2048); err != nil {
			return gen.PageSummary{}, err
		}
	}
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.Edit); err != nil {
		return gen.PageSummary{}, err
	}
	if in.Title == nil && !in.SetIcon && !in.SetCover {
		return summaryFor(ctx, s.q, userID, pageID)
	}
	row, err := s.q.UpdatePageMeta(ctx, sqlcgen.UpdatePageMetaParams{
		ID: pageID, Title: in.Title, SetIcon: in.SetIcon, Icon: in.Icon, SetCover: in.SetCover, Cover: in.Cover, EditorID: &userID,
	})
	if err != nil {
		return gen.PageSummary{}, fmt.Errorf("update page: %w", err)
	}
	s.publish(events.PageUpdated, row, userID)
	return summaryFor(ctx, s.q, userID, pageID)
}

// ---------------------------------------------------------------- move

// MoveInput is the body of POST /pages/{id}/move.
type MoveInput struct {
	ParentID *uuid.UUID
	AfterID  *uuid.UUID
	BeforeID *uuid.UUID
}

// Move reparents and/or reorders a page. It needs edit on the page and on the destination parent.
func (s *Service) Move(ctx context.Context, userID, pageID uuid.UUID, in MoveInput) (gen.PageSummary, error) {
	type moved struct {
		row         sqlcgen.Page
		oldParent   *uuid.UUID
		rootChanged bool
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (moved, error) {
		acc, err := perm.Require(ctx, q, userID, pageID, perm.Edit)
		if err != nil {
			return moved{}, err
		}
		if err := q.LockWorkspaceTree(ctx, acc.WorkspaceID.String()); err != nil {
			return moved{}, fmt.Errorf("lock tree: %w", err)
		}
		page, err := q.GetPageForUpdate(ctx, pageID)
		if err != nil {
			return moved{}, fmt.Errorf("lock page: %w", err)
		}
		oldRoot, err := q.GetRootPage(ctx, pageID)
		if err != nil {
			return moved{}, fmt.Errorf("get root: %w", err)
		}

		newRootVisibility := oldRoot.Visibility
		visibility := visibilityWorkspace
		if in.ParentID != nil {
			if *in.ParentID == pageID {
				return moved{}, apperr.FieldError("parentId", "A page cannot be moved into itself.")
			}
			parent, err := perm.Require(ctx, q, userID, *in.ParentID, perm.Edit)
			if err != nil {
				return moved{}, err
			}
			if parent.WorkspaceID != acc.WorkspaceID {
				return moved{}, perm.ErrPageNotFound
			}
			inside, err := q.IsInSubtree(ctx, sqlcgen.IsInSubtreeParams{ID: pageID, CandidateID: *in.ParentID})
			if err != nil {
				return moved{}, fmt.Errorf("cycle check: %w", err)
			}
			if inside {
				return moved{}, apperr.FieldError("parentId", "A page cannot be moved into itself or one of its subpages.")
			}
			destRoot, err := q.GetRootPage(ctx, *in.ParentID)
			if err != nil {
				return moved{}, fmt.Errorf("get destination root: %w", err)
			}
			newRootVisibility = destRoot.Visibility
		} else {
			wsRole, err := perm.RequireMember(ctx, q, acc.WorkspaceID, userID)
			if err != nil {
				return moved{}, err
			}
			if !wsRole.CanCreateRootPages() {
				return moved{}, apperr.Forbidden("Guests cannot create top-level pages.")
			}
			// A page that becomes a root keeps the visibility of the tree it came from, so moving
			// a page out of a private tree never makes it visible to the whole workspace.
			visibility = oldRoot.Visibility
			if page.ParentID == nil {
				visibility = page.Visibility
			}
			newRootVisibility = visibility
		}
		// Moving a page out of a private tree into a shared one widens its audience: that is a
		// sharing decision and needs full access, like changing visibility.
		if oldRoot.Visibility == visibilityPrivate && newRootVisibility == visibilityWorkspace && acc.Role < perm.Full {
			return moved{}, apperr.Forbidden("Moving a private page into a shared area needs full access to it.")
		}

		position, err := positionFor(ctx, q, acc.WorkspaceID, in.ParentID, pageID, in.AfterID, in.BeforeID)
		if err != nil {
			return moved{}, err
		}
		row, err := applyMove(ctx, q, userID, acc.Role, page, in.ParentID, position, visibility)
		if err != nil {
			return moved{}, err
		}
		return moved{row: row, oldParent: page.ParentID, rootChanged: !sameParent(page.ParentID, in.ParentID)}, nil
	})
	if err != nil {
		return gen.PageSummary{}, err
	}
	s.publish(events.PageMoved, res.row, userID)
	if res.rootChanged {
		// Inherited grants and visibility depend on the ancestors: every client refetches, and open
		// documents of the subtree re-authenticate.
		s.permissionsChanged(res.row.WorkspaceID, res.row.ID, userID)
		if ids, err := s.q.ListSubtreeIDs(ctx, res.row.ID); err == nil {
			s.closeSockets(ids, "permissions_changed")
		}
	}
	return summaryFor(ctx, s.q, userID, res.row.ID)
}

// applyMove stores the new parent/position/visibility. If the move would lock the actor out of the
// page (it became a root of a private tree the actor does not own) the actor keeps their previous
// role through an explicit grant.
func applyMove(ctx context.Context, q *sqlcgen.Queries, actorID uuid.UUID, actorRole perm.Role, page sqlcgen.Page, parent *uuid.UUID, position, visibility string) (sqlcgen.Page, error) {
	row, err := q.MovePage(ctx, sqlcgen.MovePageParams{ID: page.ID, ParentID: parent, Position: position, Visibility: visibility})
	if err != nil {
		return sqlcgen.Page{}, fmt.Errorf("move page: %w", err)
	}
	after, err := perm.Resolve(ctx, q, actorID, page.ID)
	if err != nil {
		return sqlcgen.Page{}, err
	}
	if after.Role == perm.None && actorRole > perm.None {
		if err := q.UpsertPagePermission(ctx, sqlcgen.UpsertPagePermissionParams{
			PageID: page.ID, UserID: actorID, Role: actorRole.String(), GrantedBy: &actorID,
		}); err != nil {
			return sqlcgen.Page{}, fmt.Errorf("keep actor access: %w", err)
		}
	}
	return row, nil
}

// ---------------------------------------------------------------- duplicate

// Duplicate copies a page (and, unless disabled, the part of its subtree the caller can view) next
// to the original. Needs view on the source and edit on the destination (the original's parent).
func (s *Service) Duplicate(ctx context.Context, userID, pageID uuid.UUID, includeSubpages bool) (gen.PageSummary, error) {
	type copied struct {
		rootID uuid.UUID
		ids    []uuid.UUID
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (copied, error) {
		src, err := perm.Require(ctx, q, userID, pageID, perm.View)
		if err != nil {
			return copied{}, err
		}
		page, err := q.GetPage(ctx, pageID)
		if err != nil {
			return copied{}, fmt.Errorf("get page: %w", err)
		}
		if page.ParentID == nil {
			wsRole, err := perm.RequireMember(ctx, q, src.WorkspaceID, userID)
			if err != nil {
				return copied{}, err
			}
			if !wsRole.CanCreateRootPages() {
				return copied{}, apperr.Forbidden("Guests cannot create top-level pages.")
			}
		} else {
			dest, err := perm.Resolve(ctx, q, userID, *page.ParentID)
			if err != nil {
				return copied{}, err
			}
			if dest.Role < perm.Edit {
				return copied{}, apperr.Forbidden("You do not have permission to add pages next to this one.")
			}
		}

		oldIDs := []uuid.UUID{pageID}
		if includeSubpages {
			if oldIDs, err = q.ListVisibleSubtree(ctx, sqlcgen.ListVisibleSubtreeParams{
				WorkspaceID: src.WorkspaceID, UserID: userID, RootID: pageID,
			}); err != nil {
				return copied{}, fmt.Errorf("list subtree: %w", err)
			}
		}
		newIDs := make([]uuid.UUID, len(oldIDs))
		for i := range newIDs {
			if newIDs[i], err = uuid.NewV7(); err != nil {
				return copied{}, fmt.Errorf("new page id: %w", err)
			}
		}

		next, err := q.SiblingPositionAfter(ctx, sqlcgen.SiblingPositionAfterParams{
			WorkspaceID: src.WorkspaceID, ParentID: page.ParentID, ExcludeID: uuid.Nil, Pos: page.Position,
		})
		if err != nil && !db.IsNotFound(err) {
			return copied{}, fmt.Errorf("next sibling: %w", err)
		}
		position, err := between(page.Position, next)
		if err != nil {
			return copied{}, err
		}
		visibility := visibilityWorkspace
		if page.ParentID == nil {
			visibility = page.Visibility
		}

		if err := q.CopyPages(ctx, sqlcgen.CopyPagesParams{
			OldIds: oldIDs, NewIds: newIDs, RootOldID: pageID, RootParentID: page.ParentID,
			RootTitle: copyTitle(page.Title), RootPosition: position, RootVisibility: visibility, ActorID: userID,
		}); err != nil {
			return copied{}, fmt.Errorf("copy pages: %w", err)
		}
		args := sqlcgen.CopyPageDocumentsParams{OldIds: oldIDs, NewIds: newIDs}
		if err := q.CopyPageDocuments(ctx, args); err != nil {
			return copied{}, fmt.Errorf("copy documents: %w", err)
		}
		if err := q.CopyPageContent(ctx, sqlcgen.CopyPageContentParams(args)); err != nil {
			return copied{}, fmt.Errorf("copy content: %w", err)
		}
		if err := q.CopyPageLinks(ctx, sqlcgen.CopyPageLinksParams(args)); err != nil {
			return copied{}, fmt.Errorf("copy links: %w", err)
		}
		return copied{rootID: newIDs[0], ids: newIDs}, nil
	})
	if err != nil {
		return gen.PageSummary{}, err
	}
	rows, err := s.q.GetPagesByIDs(ctx, res.ids)
	if err != nil {
		return gen.PageSummary{}, fmt.Errorf("load copies: %w", err)
	}
	for _, r := range rows {
		s.publish(events.PageCreated, r, userID)
	}
	return summaryFor(ctx, s.q, userID, res.rootID)
}

// copyTitle appends " (copy)" without exceeding the title limit.
func copyTitle(title string) string {
	max := validate.MaxTitleLen - utf8.RuneCountInString(copySuffix)
	if utf8.RuneCountInString(title) > max {
		title = string([]rune(title)[:max])
	}
	return title + copySuffix
}

// ---------------------------------------------------------------- archive / restore / purge

// Archive moves a page and its subtree to the trash (needs full).
func (s *Service) Archive(ctx context.Context, userID, pageID uuid.UUID) error {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.Full); err != nil {
		return err
	}
	ids, err := s.q.ArchiveSubtree(ctx, pageID)
	if err != nil {
		return fmt.Errorf("archive subtree: %w", err)
	}
	row, err := s.q.GetPage(ctx, pageID)
	if err != nil {
		return fmt.Errorf("get page: %w", err)
	}
	s.publish(events.PageArchived, row, userID)
	s.closeSockets(ids, "page_archived")
	return nil
}

// Restore brings an archived subtree back (needs full). If the parent is archived the page is
// restored at the top level.
func (s *Service) Restore(ctx context.Context, userID, pageID uuid.UUID) (gen.PageSummary, error) {
	type restored struct {
		row      sqlcgen.Page
		detached bool
	}
	res, err := db.WithTx(ctx, s.pool, func(q *sqlcgen.Queries) (restored, error) {
		acc, err := perm.Require(ctx, q, userID, pageID, perm.Full, perm.AllowArchived())
		if err != nil {
			return restored{}, err
		}
		page, err := q.GetPageForUpdate(ctx, pageID)
		if err != nil {
			return restored{}, fmt.Errorf("lock page: %w", err)
		}
		if page.ArchivedAt == nil {
			return restored{}, apperr.Conflict("This page is not in the trash.")
		}
		if _, err := q.RestoreSubtree(ctx, sqlcgen.RestoreSubtreeParams{ID: pageID, ArchivedAt: page.ArchivedAt}); err != nil {
			return restored{}, fmt.Errorf("restore subtree: %w", err)
		}
		row, err := q.GetPage(ctx, pageID)
		if err != nil {
			return restored{}, fmt.Errorf("get page: %w", err)
		}
		if page.ParentID == nil {
			return restored{row: row}, nil
		}
		parent, err := q.GetPage(ctx, *page.ParentID)
		if err != nil {
			return restored{}, fmt.Errorf("get parent: %w", err)
		}
		if parent.ArchivedAt == nil {
			return restored{row: row}, nil
		}
		// The parent is still in the trash: surface the page at the top level, keeping the
		// visibility of the tree it came from.
		oldRoot, err := q.GetRootPage(ctx, pageID)
		if err != nil {
			return restored{}, fmt.Errorf("get root: %w", err)
		}
		position, err := positionFor(ctx, q, acc.WorkspaceID, nil, pageID, nil, nil)
		if err != nil {
			return restored{}, err
		}
		row, err = applyMove(ctx, q, userID, acc.Role, page, nil, position, oldRoot.Visibility)
		return restored{row: row, detached: true}, err
	})
	if err != nil {
		return gen.PageSummary{}, err
	}
	s.publish(events.PageRestored, res.row, userID)
	if res.detached {
		s.permissionsChanged(res.row.WorkspaceID, res.row.ID, userID)
	}
	return summaryFor(ctx, s.q, userID, pageID)
}

// Purge permanently deletes an archived page and its subtree (needs full).
func (s *Service) Purge(ctx context.Context, userID, pageID uuid.UUID) error {
	acc, err := perm.Require(ctx, s.q, userID, pageID, perm.Full, perm.AllowArchived())
	if err != nil {
		return err
	}
	if !acc.Archived() {
		return apperr.Conflict("Only archived pages can be permanently deleted.")
	}
	ids, err := s.q.ListSubtreeIDs(ctx, pageID)
	if err != nil {
		return fmt.Errorf("list subtree: %w", err)
	}
	// The page is gone once deleted, so who may hear about it is decided now.
	var recipients []uuid.UUID
	for _, uid := range s.broker.SubscriberIDs(acc.WorkspaceID) {
		a, err := perm.Resolve(ctx, s.q, uid, pageID)
		if err != nil {
			return err
		}
		if a.Role >= perm.View {
			recipients = append(recipients, uid)
		}
	}
	if _, err := s.q.DeletePage(ctx, pageID); err != nil {
		return fmt.Errorf("delete page: %w", err)
	}
	s.broker.Publish(events.Event{
		Type: events.PageDeleted, WorkspaceID: acc.WorkspaceID, PageID: pageID, ActorID: userID, Recipients: recipients,
	})
	s.closeSockets(ids, "page_deleted")
	return nil
}

// ---------------------------------------------------------------- favorites

// AddFavorite marks a visible page as favorite (idempotent).
func (s *Service) AddFavorite(ctx context.Context, userID, pageID uuid.UUID) error {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.View); err != nil {
		return err
	}
	if err := s.q.AddFavorite(ctx, sqlcgen.AddFavoriteParams{UserID: userID, PageID: pageID}); err != nil {
		return fmt.Errorf("add favorite: %w", err)
	}
	return nil
}

// RemoveFavorite removes the caller's favorite (idempotent; reveals nothing about the page).
func (s *Service) RemoveFavorite(ctx context.Context, userID, pageID uuid.UUID) error {
	if err := s.q.RemoveFavorite(ctx, sqlcgen.RemoveFavoriteParams{UserID: userID, PageID: pageID}); err != nil {
		return fmt.Errorf("remove favorite: %w", err)
	}
	return nil
}
