package httpapi

import (
	"errors"
	"io"
	"net/http"
	"time"

	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
)

// sseHeartbeat is how often a ": ping" comment keeps idle connections (and proxies) alive.
const sseHeartbeat = 25 * time.Second

// SubscribeEvents: GET /workspaces/{workspaceId}/events (Server-Sent Events, conventions §5).
func (s *Server) SubscribeEvents(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if _, err := perm.RequireMember(r.Context(), s.Q, workspaceId, p.User.ID); err != nil {
		s.writeError(w, r, err)
		return
	}

	rc := http.NewResponseController(w)
	// The stream outlives the server-wide write timeout.
	if err := rc.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		s.Log.Debug("sse: cannot clear write deadline", "err", err)
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no") // do not let nginx-style proxies buffer the stream
	w.WriteHeader(http.StatusOK)
	// Flush the headers right away so the client's EventSource opens immediately.
	if _, err := io.WriteString(w, ": connected\n\n"); err != nil {
		return
	}
	if err := rc.Flush(); err != nil {
		return
	}

	sub := s.Broker.Subscribe(workspaceId, p.User.ID, p.SessionID)
	defer sub.Close()
	err := sub.Serve(r.Context(), w, rc.Flush, sseHeartbeat)
	if err != nil && !errors.Is(err, events.ErrClosed) && r.Context().Err() == nil {
		s.Log.Debug("sse stream ended", "err", err)
	}
}
