// Package comments implements block-anchored comment threads stored only in Postgres (conventions
// §10). Authors can edit/delete their own comments; `full` can delete any. Live updates go out over
// SSE (comment.*).
package comments

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
	"hostidian/backend/internal/validate"
)

const (
	maxBlockIDLen = 100
	maxQuoteLen   = 500
	maxCommentLen = 10000
)

// Service holds the comment use cases.
type Service struct {
	q      *sqlcgen.Queries
	pool   *pgxpool.Pool
	broker *events.Broker
	log    *slog.Logger
	now    func() time.Time
}

// Options configure NewService.
type Options struct {
	Q      *sqlcgen.Queries
	Pool   *pgxpool.Pool
	Broker *events.Broker
	Log    *slog.Logger
	Now    func() time.Time
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Service{q: o.Q, pool: o.Pool, broker: o.Broker, log: o.Log, now: o.Now}
}

// CreateThreadInput is the body of POST /pages/{pageId}/comments.
type CreateThreadInput struct {
	BlockID string
	Quote   string
	Body    string
}

// Create starts a thread with its first comment. Needs `comment`.
func (s *Service) Create(ctx context.Context, userID, pageID uuid.UUID, in CreateThreadInput) (gen.CommentThread, error) {
	acc, err := perm.Require(ctx, s.q, userID, pageID, perm.Comment)
	if err != nil {
		return gen.CommentThread{}, err
	}
	if err := validate.ShortString("blockId", in.BlockID, maxBlockIDLen); err != nil || in.BlockID == "" {
		if err == nil {
			err = apperr.FieldError("blockId", "This field is required.")
		}
		return gen.CommentThread{}, err
	}
	if err := validate.ShortString("quote", in.Quote, maxQuoteLen); err != nil {
		return gen.CommentThread{}, err
	}
	if err := checkBody(in.Body); err != nil {
		return gen.CommentThread{}, err
	}
	var thread sqlcgen.CommentThread
	err = db.InTx(ctx, s.pool, func(q *sqlcgen.Queries) error {
		t, err := q.InsertCommentThread(ctx, sqlcgen.InsertCommentThreadParams{
			PageID: pageID, BlockID: in.BlockID, Quote: in.Quote, CreatedBy: userID,
		})
		if err != nil {
			return fmt.Errorf("insert thread: %w", err)
		}
		thread = t
		if _, err := q.InsertComment(ctx, sqlcgen.InsertCommentParams{
			ThreadID: t.ID, AuthorID: userID, Body: in.Body,
		}); err != nil {
			return fmt.Errorf("insert comment: %w", err)
		}
		return nil
	})
	if err != nil {
		return gen.CommentThread{}, err
	}
	s.publish(events.CommentCreated, acc.WorkspaceID, pageID, userID, thread.ID)
	return s.renderThread(ctx, thread)
}

// List returns the threads of a page. Needs `view`.
func (s *Service) List(ctx context.Context, userID, pageID uuid.UUID, includeResolved bool) ([]gen.CommentThread, error) {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.View); err != nil {
		return nil, err
	}
	threads, err := s.q.ListCommentThreads(ctx, sqlcgen.ListCommentThreadsParams{
		PageID: pageID, IncludeResolved: includeResolved,
	})
	if err != nil {
		return nil, fmt.Errorf("list threads: %w", err)
	}
	return s.renderThreads(ctx, threads)
}

// Reply adds a comment to a thread. Needs `comment` on the thread's page.
func (s *Service) Reply(ctx context.Context, userID, threadID uuid.UUID, body string) (gen.Comment, error) {
	thread, acc, err := s.threadAccess(ctx, userID, threadID, perm.Comment)
	if err != nil {
		return gen.Comment{}, err
	}
	if err := checkBody(body); err != nil {
		return gen.Comment{}, err
	}
	c, err := s.q.InsertComment(ctx, sqlcgen.InsertCommentParams{ThreadID: threadID, AuthorID: userID, Body: body})
	if err != nil {
		return gen.Comment{}, fmt.Errorf("insert comment: %w", err)
	}
	s.publish(events.CommentCreated, acc.WorkspaceID, thread.PageID, userID, threadID)
	return s.toComment(ctx, c.ID, c.ThreadID, userID, body, c.CreatedAt, c.UpdatedAt), nil
}

// Update changes a comment's body (author only).
func (s *Service) Update(ctx context.Context, userID, commentID uuid.UUID, body string) (gen.Comment, error) {
	c, thread, acc, err := s.commentAccess(ctx, userID, commentID)
	if err != nil {
		return gen.Comment{}, err
	}
	if c.AuthorID != userID {
		return gen.Comment{}, apperr.Forbidden("Only the author can edit a comment.")
	}
	if err := checkBody(body); err != nil {
		return gen.Comment{}, err
	}
	updated, err := s.q.UpdateComment(ctx, sqlcgen.UpdateCommentParams{ID: commentID, Body: body})
	if err != nil {
		return gen.Comment{}, fmt.Errorf("update comment: %w", err)
	}
	s.publish(events.CommentUpdated, acc.WorkspaceID, thread.PageID, userID, thread.ID)
	return s.toComment(ctx, updated.ID, updated.ThreadID, userID, updated.Body, updated.CreatedAt, updated.UpdatedAt), nil
}

// Delete removes a comment (author or `full`). The thread is removed once it has no comments left.
func (s *Service) Delete(ctx context.Context, userID, commentID uuid.UUID) error {
	c, thread, acc, err := s.commentAccess(ctx, userID, commentID)
	if err != nil {
		return err
	}
	authorized := c.AuthorID == userID
	if !authorized {
		if _, err := perm.Require(ctx, s.q, userID, thread.PageID, perm.Full); err == nil {
			authorized = true
		}
	}
	if !authorized {
		return apperr.Forbidden("Only the author or a page owner can delete a comment.")
	}
	if _, err := s.q.DeleteComment(ctx, commentID); err != nil {
		return fmt.Errorf("delete comment: %w", err)
	}
	if _, err := s.q.DeleteEmptyCommentThread(ctx, thread.ID); err != nil {
		return fmt.Errorf("prune thread: %w", err)
	}
	s.publish(events.CommentDeleted, acc.WorkspaceID, thread.PageID, userID, thread.ID)
	return nil
}

// Resolve marks a thread resolved. Needs `comment`.
func (s *Service) Resolve(ctx context.Context, userID, threadID uuid.UUID) (gen.CommentThread, error) {
	thread, acc, err := s.threadAccess(ctx, userID, threadID, perm.Comment)
	if err != nil {
		return gen.CommentThread{}, err
	}
	if thread.ResolvedAt == nil {
		if thread, err = s.q.ResolveCommentThread(ctx, sqlcgen.ResolveCommentThreadParams{ID: threadID, ResolvedBy: &userID}); err != nil {
			if db.IsNotFound(err) {
				return gen.CommentThread{}, apperr.NotFound("Comment thread not found.")
			}
			return gen.CommentThread{}, fmt.Errorf("resolve thread: %w", err)
		}
		s.publish(events.CommentResolved, acc.WorkspaceID, thread.PageID, userID, threadID)
	}
	return s.renderThread(ctx, thread)
}

// Reopen clears a thread's resolved state. Needs `comment`.
func (s *Service) Reopen(ctx context.Context, userID, threadID uuid.UUID) (gen.CommentThread, error) {
	_, acc, err := s.threadAccess(ctx, userID, threadID, perm.Comment)
	if err != nil {
		return gen.CommentThread{}, err
	}
	thread, err := s.q.ReopenCommentThread(ctx, threadID)
	if err != nil {
		if db.IsNotFound(err) {
			return gen.CommentThread{}, apperr.NotFound("Comment thread not found.")
		}
		return gen.CommentThread{}, fmt.Errorf("reopen thread: %w", err)
	}
	s.publish(events.CommentUpdated, acc.WorkspaceID, thread.PageID, userID, threadID)
	return s.renderThread(ctx, thread)
}

// ---------------------------------------------------------------- helpers

func (s *Service) threadAccess(ctx context.Context, userID, threadID uuid.UUID, min perm.Role) (sqlcgen.CommentThread, perm.Access, error) {
	thread, err := s.q.GetCommentThread(ctx, threadID)
	if err != nil {
		if db.IsNotFound(err) {
			return sqlcgen.CommentThread{}, perm.Access{}, apperr.NotFound("Comment thread not found.")
		}
		return sqlcgen.CommentThread{}, perm.Access{}, fmt.Errorf("get thread: %w", err)
	}
	acc, err := perm.Require(ctx, s.q, userID, thread.PageID, min)
	if err != nil {
		return sqlcgen.CommentThread{}, perm.Access{}, err
	}
	return thread, acc, nil
}

func (s *Service) commentAccess(ctx context.Context, userID, commentID uuid.UUID) (sqlcgen.Comment, sqlcgen.CommentThread, perm.Access, error) {
	c, err := s.q.GetComment(ctx, commentID)
	if err != nil {
		if db.IsNotFound(err) {
			return sqlcgen.Comment{}, sqlcgen.CommentThread{}, perm.Access{}, apperr.NotFound("Comment not found.")
		}
		return sqlcgen.Comment{}, sqlcgen.CommentThread{}, perm.Access{}, fmt.Errorf("get comment: %w", err)
	}
	thread, acc, err := s.threadAccess(ctx, userID, c.ThreadID, perm.View)
	if err != nil {
		return sqlcgen.Comment{}, sqlcgen.CommentThread{}, perm.Access{}, err
	}
	return c, thread, acc, nil
}

func (s *Service) publish(typ string, workspaceID, pageID, actorID, threadID uuid.UUID) {
	if s.broker == nil {
		return
	}
	s.broker.Publish(events.Event{
		Type: typ, WorkspaceID: workspaceID, PageID: pageID, ActorID: actorID,
		Data: map[string]any{"threadId": threadID},
	})
}

func (s *Service) renderThreads(ctx context.Context, threads []sqlcgen.CommentThread) ([]gen.CommentThread, error) {
	out := make([]gen.CommentThread, 0, len(threads))
	for _, t := range threads {
		rendered, err := s.renderThread(ctx, t)
		if err != nil {
			return nil, err
		}
		out = append(out, rendered)
	}
	return out, nil
}

func (s *Service) renderThread(ctx context.Context, t sqlcgen.CommentThread) (gen.CommentThread, error) {
	rows, err := s.q.ListThreadComments(ctx, []uuid.UUID{t.ID})
	if err != nil {
		return gen.CommentThread{}, fmt.Errorf("list thread comments: %w", err)
	}
	out := gen.CommentThread{
		Id: t.ID, PageId: t.PageID, BlockId: t.BlockID, Quote: t.Quote,
		CreatedAt: t.CreatedAt, ResolvedAt: t.ResolvedAt,
		Comments: make([]gen.Comment, 0, len(rows)),
	}
	for _, r := range rows {
		out.Comments = append(out.Comments, gen.Comment{
			Id: r.ID, ThreadId: r.ThreadID, Body: r.Body, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
			Author: gen.UserRef{Id: r.AuthorID, Name: r.Name, AvatarColor: r.AvatarColor},
		})
	}
	if u, err := s.userRef(ctx, t.CreatedBy); err != nil {
		return gen.CommentThread{}, err
	} else {
		out.CreatedBy = u
	}
	if t.ResolvedBy != nil {
		if u, err := s.userRef(ctx, *t.ResolvedBy); err != nil {
			return gen.CommentThread{}, err
		} else {
			out.ResolvedBy = u
		}
	}
	return out, nil
}

func (s *Service) toComment(ctx context.Context, id, threadID, authorID uuid.UUID, body string, created, updated time.Time) gen.Comment {
	ref := gen.UserRef{Id: authorID}
	if u, err := s.q.GetUserByID(ctx, authorID); err == nil {
		ref.Name = u.Name
		ref.AvatarColor = u.AvatarColor
	}
	return gen.Comment{Id: id, ThreadId: threadID, Author: ref, Body: body, CreatedAt: created, UpdatedAt: updated}
}

func (s *Service) userRef(ctx context.Context, id uuid.UUID) (*gen.UserRef, error) {
	u, err := s.q.GetUserByID(ctx, id)
	if err != nil {
		if db.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get user: %w", err)
	}
	return &gen.UserRef{Id: u.ID, Name: u.Name, AvatarColor: u.AvatarColor}, nil
}

func checkBody(body string) error {
	if len([]rune(body)) < 1 {
		return apperr.FieldError("body", "This field is required.")
	}
	if len([]rune(body)) > maxCommentLen {
		return apperr.FieldError("body", "Must be at most 10000 characters.")
	}
	return nil
}
