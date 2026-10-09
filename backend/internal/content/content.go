// Package content owns the derived page content (blocks/markdown/plaintext) and the
// permission-filtered read models built on top of it: backlinks, the link graph and search
// (conventions §8/§9). The internal ingestion endpoint (collab → api) also lives here.
package content

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/pages"
	"hostidian/backend/internal/perm"
)

// Service holds the content use cases.
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

// ---------------------------------------------------------------- ingestion (internal)

// IngestInput is the body of PUT /internal/pages/{pageId}/content (api/internal.yaml).
type IngestInput struct {
	Markdown    string
	Plaintext   string
	Blocks      json.RawMessage
	LinkTargets []uuid.UUID
	EditorIDs   []uuid.UUID
}

// Ingest stores the extracted document content, replaces its outgoing links, bumps the page's
// updated_at/last_edited_by and emits a page.updated event. Returns a 404 when the page is gone.
func (s *Service) Ingest(ctx context.Context, pageID uuid.UUID, in IngestInput) error {
	row, err := s.q.GetPage(ctx, pageID)
	if err != nil {
		if db.IsNotFound(err) {
			return perm.ErrPageNotFound
		}
		return fmt.Errorf("get page: %w", err)
	}
	blocks := in.Blocks
	if len(blocks) == 0 {
		blocks = json.RawMessage("[]")
	}
	editor := s.firstValidEditor(ctx, in.EditorIDs)

	if err := db.InTx(ctx, s.pool, func(q *sqlcgen.Queries) error {
		if err := q.UpsertPageContent(ctx, sqlcgen.UpsertPageContentParams{
			PageID: pageID, Markdown: in.Markdown, Plaintext: in.Plaintext, Blocks: blocks,
		}); err != nil {
			return fmt.Errorf("upsert content: %w", err)
		}
		if err := q.DeletePageLinks(ctx, pageID); err != nil {
			return fmt.Errorf("replace links: %w", err)
		}
		if len(in.LinkTargets) > 0 {
			if err := q.InsertPageLinks(ctx, sqlcgen.InsertPageLinksParams{
				SourcePageID: pageID, Targets: in.LinkTargets,
			}); err != nil {
				return fmt.Errorf("insert links: %w", err)
			}
		}
		return q.TouchPageEdited(ctx, sqlcgen.TouchPageEditedParams{ID: pageID, EditorID: editor})
	}); err != nil {
		return err
	}

	row, err = s.q.GetPage(ctx, pageID)
	if err != nil {
		return fmt.Errorf("reload page: %w", err)
	}
	if s.broker != nil {
		sum := pages.ToSummary(row, perm.None, true)
		sum.Role = ""
		s.broker.Publish(events.Event{Type: events.PageUpdated, WorkspaceID: row.WorkspaceID, PageID: pageID, Page: &sum})
	}
	return nil
}

func (s *Service) firstValidEditor(ctx context.Context, ids []uuid.UUID) *uuid.UUID {
	for i := range ids {
		if _, err := s.q.GetUserByID(ctx, ids[i]); err == nil {
			id := ids[i]
			return &id
		}
	}
	return nil
}

// ---------------------------------------------------------------- reads

// GetPageContent returns the last extracted content. Needs `view`; a page without stored content
// returns empty blocks/markdown.
func (s *Service) GetPageContent(ctx context.Context, userID, pageID uuid.UUID) (gen.PageContent, error) {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.View); err != nil {
		return gen.PageContent{}, err
	}
	pc, err := s.q.GetPageContent(ctx, pageID)
	if err != nil {
		if db.IsNotFound(err) {
			page, err := s.q.GetPage(ctx, pageID)
			if err != nil {
				return gen.PageContent{}, fmt.Errorf("get page: %w", err)
			}
			return gen.PageContent{Blocks: []map[string]any{}, Markdown: "", UpdatedAt: page.UpdatedAt}, nil
		}
		return gen.PageContent{}, fmt.Errorf("get content: %w", err)
	}
	var blocks []map[string]any
	if err := json.Unmarshal(pc.Blocks, &blocks); err != nil {
		s.log.Warn("stored blocks are not valid JSON", "page", pageID, "err", err)
		blocks = []map[string]any{}
	}
	return gen.PageContent{Blocks: blocks, Markdown: pc.Markdown, UpdatedAt: pc.UpdatedAt}, nil
}

// Backlinks lists visible pages that link to this page. Needs `view`.
func (s *Service) Backlinks(ctx context.Context, userID, pageID uuid.UUID) ([]gen.PageRef, error) {
	acc, err := perm.Require(ctx, s.q, userID, pageID, perm.View)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListBacklinks(ctx, sqlcgen.ListBacklinksParams{
		TargetPageID: pageID, WorkspaceID: acc.WorkspaceID, UserID: userID,
	})
	if err != nil {
		return nil, fmt.Errorf("list backlinks: %w", err)
	}
	out := make([]gen.PageRef, 0, len(rows))
	for _, r := range rows {
		out = append(out, gen.PageRef{Id: r.ID, Title: r.Title, Icon: r.Icon})
	}
	return out, nil
}

// Graph returns the link graph of every page the caller can view. Needs workspace membership.
func (s *Service) Graph(ctx context.Context, userID, workspaceID uuid.UUID) (gen.Graph, error) {
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return gen.Graph{}, err
	}
	nodes, err := s.q.ListGraphNodes(ctx, sqlcgen.ListGraphNodesParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return gen.Graph{}, fmt.Errorf("list graph nodes: %w", err)
	}
	edges, err := s.q.ListGraphEdges(ctx, sqlcgen.ListGraphEdgesParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return gen.Graph{}, fmt.Errorf("list graph edges: %w", err)
	}
	out := gen.Graph{
		Nodes: []graphNode{},
		Edges: []graphEdge{},
	}
	for _, n := range nodes {
		count := int(n.LinkCount)
		out.Nodes = append(out.Nodes, graphNode{Id: n.ID, Title: n.Title, Icon: n.Icon, ParentId: n.ParentID, LinkCount: &count})
	}
	for _, e := range edges {
		out.Edges = append(out.Edges, graphEdge{Source: e.Source, Target: e.Target})
	}
	return out, nil
}

// graphNode / graphEdge are aliases for the anonymous element types generated for gen.Graph, so the
// service can build the response without repeating the inline struct.
type graphNode = struct {
	Icon      *string             `json:"icon,omitempty"`
	Id        openapi_types.UUID  `json:"id"`
	LinkCount *int                `json:"linkCount,omitempty"`
	ParentId  *openapi_types.UUID `json:"parentId,omitempty"`
	Title     string              `json:"title"`
}

type graphEdge = struct {
	Source openapi_types.UUID `json:"source"`
	Target openapi_types.UUID `json:"target"`
}

// SearchMode selects the search strategy.
type SearchMode string

const (
	// ModeFull is title + body FTS with snippets.
	ModeFull SearchMode = "full"
	// ModeTitle is fuzzy title matching for the quick switcher.
	ModeTitle SearchMode = "title"
)

// Search runs a permission-filtered search over a workspace.
func (s *Service) Search(ctx context.Context, userID, workspaceID uuid.UUID, query string, mode SearchMode, limit int) ([]gen.SearchResult, error) {
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if utf8Len(query) < 1 || utf8Len(query) > 200 {
		return nil, apperr.FieldError("q", "Must be between 1 and 200 characters.")
	}
	if limit < 1 || limit > 50 {
		limit = 20
	}
	out := []gen.SearchResult{}
	switch mode {
	case ModeTitle:
		rows, err := s.q.SearchPagesTitle(ctx, sqlcgen.SearchPagesTitleParams{
			Query: query, WorkspaceID: workspaceID, UserID: userID, MaxRows: int32(limit),
		})
		if err != nil {
			return nil, fmt.Errorf("title search: %w", err)
		}
		for _, r := range rows {
			out = append(out, gen.SearchResult{
				Page: pages.ToSummary(r.Page, perm.FromRank(r.RoleRank), r.ParentVisible),
				Rank: float32(r.Rank),
			})
		}
	default:
		tsq := buildPrefixTsquery(query)
		if tsq == "" {
			return out, nil
		}
		rows, err := s.q.SearchPagesFull(ctx, sqlcgen.SearchPagesFullParams{
			Tsquery: tsq, WorkspaceID: workspaceID, UserID: userID, MaxRows: int32(limit),
		})
		if err != nil {
			return nil, fmt.Errorf("full search: %w", err)
		}
		for _, r := range rows {
			res := gen.SearchResult{
				Page: pages.ToSummary(r.Page, perm.FromRank(r.RoleRank), r.ParentVisible),
				Rank: float32(r.Rank),
			}
			if len(r.Snippet) > 0 {
				snippet := MarkSnippet(string(r.Snippet))
				res.Snippet = &snippet
			}
			out = append(out, res)
		}
	}
	return out, nil
}

// buildPrefixTsquery turns free-form user input into a safe tsquery: alphanumeric tokens joined by
// AND, with prefix matching on the last token. Returns "" when there is nothing searchable.
func buildPrefixTsquery(q string) string {
	fields := strings.Fields(q)
	tokens := make([]string, 0, len(fields))
	for _, f := range fields {
		tok := strings.Map(func(r rune) rune {
			if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
				return r
			}
			return -1
		}, f)
		if tok != "" {
			tokens = append(tokens, tok)
		}
	}
	if len(tokens) == 0 {
		return ""
	}
	tokens[len(tokens)-1] += ":*"
	return strings.Join(tokens, " & ")
}

func utf8Len(s string) int { return len([]rune(s)) }

// Sentinels ts_headline wraps matches in (private-use code points, see queries/content.sql).
const (
	hlStart = "\ue000"
	hlStop  = "\ue001"
)

// MarkSnippet turns a ts_headline result into the API's snippet format (conventions §9, openapi
// SearchResult.snippet): the text is HTML-escaped and matches are wrapped in <mark>…</mark>, so clients
// may render it as HTML safely.
func MarkSnippet(s string) string {
	s = html.EscapeString(s)
	s = strings.ReplaceAll(s, hlStart, "<mark>")
	return strings.ReplaceAll(s, hlStop, "</mark>")
}
