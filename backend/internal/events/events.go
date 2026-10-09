// Package events is the in-process pub/sub behind GET /workspaces/{id}/events (conventions §5).
//
// Mutations call Broker.Publish after their transaction committed. Publishing never blocks and
// never touches the database; the per-subscriber permission check happens on the subscriber's own
// goroutine in Subscription.Serve, so a slow client can only hurt itself. Wave-2 code publishes with
//
//	broker.Publish(events.Event{Type: events.CommentCreated, WorkspaceID: ws, PageID: page,
//	                            ActorID: user, Data: map[string]any{"threadId": id}})
//
// and gets the visibility filtering for free.
package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
)

// Event types (conventions §5).
const (
	PageCreated        = "page.created"
	PageUpdated        = "page.updated"
	PageMoved          = "page.moved"
	PageArchived       = "page.archived"
	PageRestored       = "page.restored"
	PageDeleted        = "page.deleted"
	PermissionsChanged = "permissions.changed"
	CommentCreated     = "comment.created"
	CommentUpdated     = "comment.updated"
	CommentResolved    = "comment.resolved"
	CommentDeleted     = "comment.deleted"
	MemberChanged      = "member.changed"
)

// Audience selects who may receive an event.
type Audience int

const (
	// AudiencePageViewers (default when PageID is set): subscribers with at least `view` on PageID.
	AudiencePageViewers Audience = iota
	// AudienceMembers: non-guest members of the workspace (default when PageID is unset).
	AudienceMembers
	// AudienceAll: every subscriber of the workspace. PageID, if set, is only revealed to those who
	// can view that page (permissions.changed uses this: every client must refetch).
	AudienceAll
)

// Event is one thing that happened in a workspace.
type Event struct {
	Type        string
	WorkspaceID uuid.UUID
	PageID      uuid.UUID // uuid.Nil when the event is not about a page
	ActorID     uuid.UUID // uuid.Nil when unknown (e.g. system)
	At          time.Time // defaults to now
	// Page, when set, is sent as `data`; its role and parentId are rewritten for every subscriber.
	Page *gen.PageSummary
	// Data is sent as `data` when Page is nil.
	Data     map[string]any
	Audience Audience
	// Recipients, when non-empty, restricts delivery to these users and skips the permission
	// lookup. Used for page.deleted, where the page no longer exists when the event is delivered:
	// the publisher computes the audience before deleting (see Broker.SubscriberIDs).
	Recipients []uuid.UUID
}

func (e Event) audience() Audience {
	if e.Audience == AudiencePageViewers && e.PageID == uuid.Nil {
		return AudienceMembers
	}
	return e.Audience
}

// invalidates reports whether the event can change what a subscriber may see.
func (e Event) invalidates() bool {
	switch e.Type {
	case PermissionsChanged, PageMoved, PageRestored, PageArchived, PageDeleted, MemberChanged:
		return true
	}
	return false
}

// Broker fans events out to the subscribers of a workspace.
type Broker struct {
	q   *sqlcgen.Queries
	log *slog.Logger
	buf int

	mu     sync.RWMutex
	byWS   map[uuid.UUID]map[*Subscription]struct{}
	closed bool
}

// NewBroker creates a broker. q is used for the per-subscriber permission checks.
func NewBroker(q *sqlcgen.Queries, log *slog.Logger) *Broker {
	return &Broker{q: q, log: log, buf: 256, byWS: map[uuid.UUID]map[*Subscription]struct{}{}}
}

// ErrClosed is returned by Serve when the subscription was terminated by the server (the client
// should reconnect and refetch).
var ErrClosed = errors.New("events: subscription closed")

// Subscription is one SSE client.
type Subscription struct {
	b         *Broker
	workspace uuid.UUID
	user      uuid.UUID
	session   uuid.UUID

	ch        chan Event
	done      chan struct{}
	closeOnce sync.Once
	reason    string

	cache map[uuid.UUID]perm.Access // only touched by the Serve goroutine
}

// Subscribe registers a subscriber. Call Close when done.
func (b *Broker) Subscribe(workspaceID, userID, sessionID uuid.UUID) *Subscription {
	s := &Subscription{
		b: b, workspace: workspaceID, user: userID, session: sessionID,
		ch: make(chan Event, b.buf), done: make(chan struct{}), cache: map[uuid.UUID]perm.Access{},
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		s.kill("server shutting down")
		return s
	}
	if b.byWS[workspaceID] == nil {
		b.byWS[workspaceID] = map[*Subscription]struct{}{}
	}
	b.byWS[workspaceID][s] = struct{}{}
	return s
}

// Close unregisters the subscription.
func (s *Subscription) Close() {
	s.kill("closed")
	s.b.mu.Lock()
	defer s.b.mu.Unlock()
	if set := s.b.byWS[s.workspace]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(s.b.byWS, s.workspace)
		}
	}
}

func (s *Subscription) kill(reason string) {
	s.closeOnce.Do(func() {
		s.reason = reason
		close(s.done)
	})
}

// Publish queues the event for every subscriber of its workspace. It never blocks: a subscriber
// whose buffer is full is disconnected and will refetch on reconnect (events are only hints).
func (b *Broker) Publish(ev Event) {
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for s := range b.byWS[ev.WorkspaceID] {
		select {
		case s.ch <- ev:
		default:
			b.log.Warn("sse subscriber too slow, dropping connection", "workspace", ev.WorkspaceID, "user", s.user)
			s.kill("overflow")
		}
	}
}

// SubscriberIDs lists the distinct users currently subscribed to a workspace.
func (b *Broker) SubscriberIDs(workspaceID uuid.UUID) []uuid.UUID {
	b.mu.RLock()
	defer b.mu.RUnlock()
	seen := map[uuid.UUID]struct{}{}
	var out []uuid.UUID
	for s := range b.byWS[workspaceID] {
		if _, ok := seen[s.user]; !ok {
			seen[s.user] = struct{}{}
			out = append(out, s.user)
		}
	}
	return out
}

// CloseWhere terminates matching subscriptions (user disabled, session revoked, workspace deleted…).
func (b *Broker) CloseWhere(reason string, match func(workspace, user, session uuid.UUID) bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, set := range b.byWS {
		for s := range set {
			if match(s.workspace, s.user, s.session) {
				s.kill(reason)
			}
		}
	}
}

// CloseUser terminates every subscription of a user, optionally sparing one session.
func (b *Broker) CloseUser(userID uuid.UUID, exceptSession uuid.UUID, reason string) {
	b.CloseWhere(reason, func(_, u, sess uuid.UUID) bool {
		return u == userID && (exceptSession == uuid.Nil || sess != exceptSession)
	})
}

// CloseSession terminates the subscriptions opened with one session.
func (b *Broker) CloseSession(sessionID uuid.UUID, reason string) {
	b.CloseWhere(reason, func(_, _, sess uuid.UUID) bool { return sess == sessionID })
}

// CloseWorkspace terminates every subscription of a workspace.
func (b *Broker) CloseWorkspace(workspaceID uuid.UUID, reason string) {
	b.CloseWhere(reason, func(ws, _, _ uuid.UUID) bool { return ws == workspaceID })
}

// CloseMember terminates one user's subscriptions to one workspace.
func (b *Broker) CloseMember(workspaceID, userID uuid.UUID, reason string) {
	b.CloseWhere(reason, func(ws, u, _ uuid.UUID) bool { return ws == workspaceID && u == userID })
}

// Shutdown terminates all subscriptions and refuses new ones (graceful server stop).
func (b *Broker) Shutdown() {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	b.CloseWhere("server shutting down", func(_, _, _ uuid.UUID) bool { return true })
}

// wire is the JSON of one SSE message.
type wire struct {
	Type        string     `json:"type"`
	WorkspaceID uuid.UUID  `json:"workspaceId"`
	PageID      *uuid.UUID `json:"pageId,omitempty"`
	ActorID     *uuid.UUID `json:"actorId,omitempty"`
	At          time.Time  `json:"at"`
	Data        any        `json:"data"`
}

// Serve streams events to w until ctx ends or the subscription is terminated. flush must push the
// buffered bytes to the client. A ": ping" comment is written every heartbeat.
func (s *Subscription) Serve(ctx context.Context, w io.Writer, flush func() error, heartbeat time.Duration) error {
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-s.done:
			return ErrClosed
		case <-ticker.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return err
			}
			if err := flush(); err != nil {
				return err
			}
		case ev := <-s.ch:
			msg, ok := s.render(ctx, ev)
			if !ok {
				continue
			}
			if _, err := w.Write(msg); err != nil {
				return err
			}
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

// render decides whether this subscriber may see the event and builds the SSE frame. It fails
// closed: any lookup error drops the event.
func (s *Subscription) render(ctx context.Context, ev Event) ([]byte, bool) {
	if ev.invalidates() {
		clear(s.cache)
	}

	// Membership is always re-checked: a removed member must stop receiving anything.
	role, isMember, err := perm.MemberRole(ctx, s.b.q, s.workspace, s.user)
	if err != nil {
		s.b.log.Warn("sse membership check failed", "err", err)
		return nil, false
	}
	if !isMember {
		s.kill("no longer a member")
		return nil, false
	}

	var access perm.Access
	if ev.PageID != uuid.Nil {
		access, err = s.access(ctx, ev.PageID)
		if err != nil {
			s.b.log.Warn("sse permission check failed", "err", err)
			return nil, false
		}
	}

	if len(ev.Recipients) > 0 {
		found := false
		for _, id := range ev.Recipients {
			if id == s.user {
				found = true
				break
			}
		}
		if !found {
			return nil, false
		}
	} else {
		switch ev.audience() {
		case AudiencePageViewers:
			if access.Role < perm.View {
				return nil, false
			}
		case AudienceMembers:
			if role == perm.Guest {
				return nil, false
			}
		case AudienceAll:
		}
	}

	out := wire{Type: ev.Type, WorkspaceID: ev.WorkspaceID, At: ev.At, Data: map[string]any{}}
	// pageId is only revealed to subscribers who may view the page (permissions.changed reaches
	// everybody but must not leak ids of private pages).
	if ev.PageID != uuid.Nil && (access.Role >= perm.View || len(ev.Recipients) > 0) {
		id := ev.PageID
		out.PageID = &id
	}
	if ev.ActorID != uuid.Nil {
		id := ev.ActorID
		out.ActorID = &id
	}
	switch {
	case ev.Page != nil:
		summary := *ev.Page
		if len(ev.Recipients) == 0 {
			summary.Role = gen.EffectiveRole(access.Role.String())
			if !access.ParentVisible {
				summary.ParentId = nil
			}
		}
		out.Data = summary
	case ev.Data != nil:
		out.Data = ev.Data
	}

	payload, err := json.Marshal(out)
	if err != nil {
		s.b.log.Error("marshal sse event", "err", err)
		return nil, false
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", ev.Type, payload)), true
}

func (s *Subscription) access(ctx context.Context, pageID uuid.UUID) (perm.Access, error) {
	if a, ok := s.cache[pageID]; ok {
		return a, nil
	}
	a, err := perm.Resolve(ctx, s.b.q, s.user, pageID)
	if err != nil {
		return perm.Access{}, err
	}
	if len(s.cache) > 2048 {
		clear(s.cache)
	}
	s.cache[pageID] = a
	return a, nil
}

// HasSubscriber reports whether the user currently has a live subscription to the workspace.
func (b *Broker) HasSubscriber(workspaceID, userID uuid.UUID) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for s := range b.byWS[workspaceID] {
		if s.user == userID {
			return true
		}
	}
	return false
}
