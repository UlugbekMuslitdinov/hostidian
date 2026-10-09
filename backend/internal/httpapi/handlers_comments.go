package httpapi

import (
	"net/http"

	"github.com/google/uuid"

	"hostidian/backend/internal/comments"
	"hostidian/backend/internal/httpapi/gen"
)

func commentsService(s *Server) *comments.Service {
	return Ext(s, "comments", func() *comments.Service {
		return comments.NewService(comments.Options{Q: s.Deps.Q, Pool: s.Pool, Broker: s.Broker, Log: s.Log})
	})
}

// ListCommentThreads: GET /pages/{pageId}/comments
func (s *Server) ListCommentThreads(w http.ResponseWriter, r *http.Request, pageId gen.PageId, params gen.ListCommentThreadsParams) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	includeResolved := params.IncludeResolved != nil && *params.IncludeResolved
	out, err := commentsService(s).List(r.Context(), p.User.ID, uuid.UUID(pageId), includeResolved)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateCommentThread: POST /pages/{pageId}/comments
func (s *Server) CreateCommentThread(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.CreateCommentThreadJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	quote := ""
	if body.Quote != nil {
		quote = *body.Quote
	}
	out, err := commentsService(s).Create(r.Context(), p.User.ID, uuid.UUID(pageId), comments.CreateThreadInput{
		BlockID: body.BlockId, Quote: quote, Body: body.Body,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// ReplyToThread: POST /comment-threads/{threadId}/comments
func (s *Server) ReplyToThread(w http.ResponseWriter, r *http.Request, threadId gen.ThreadId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.ReplyToThreadJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out, err := commentsService(s).Reply(r.Context(), p.User.ID, uuid.UUID(threadId), body.Body)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// ResolveThread: POST /comment-threads/{threadId}/resolve
func (s *Server) ResolveThread(w http.ResponseWriter, r *http.Request, threadId gen.ThreadId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := commentsService(s).Resolve(r.Context(), p.User.ID, uuid.UUID(threadId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ReopenThread: POST /comment-threads/{threadId}/reopen
func (s *Server) ReopenThread(w http.ResponseWriter, r *http.Request, threadId gen.ThreadId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := commentsService(s).Reopen(r.Context(), p.User.ID, uuid.UUID(threadId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpdateComment: PATCH /comments/{commentId}
func (s *Server) UpdateComment(w http.ResponseWriter, r *http.Request, commentId uuid.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.UpdateCommentJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out, err := commentsService(s).Update(r.Context(), p.User.ID, uuid.UUID(commentId), body.Body)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteComment: DELETE /comments/{commentId}
func (s *Server) DeleteComment(w http.ResponseWriter, r *http.Request, commentId uuid.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := commentsService(s).Delete(r.Context(), p.User.ID, uuid.UUID(commentId)); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}
