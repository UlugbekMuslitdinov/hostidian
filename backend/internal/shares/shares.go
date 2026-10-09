// Package shares manages public share links and serves the read-only public page endpoints
// (conventions §11). Public responses never expose emails or user ids.
package shares

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/files"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
)

// Service holds the share use cases.
type Service struct {
	q         *sqlcgen.Queries
	files     *files.Service
	log       *slog.Logger
	publicURL string
	now       func() time.Time
}

// Options configure NewService.
type Options struct {
	Q         *sqlcgen.Queries
	Files     *files.Service
	Log       *slog.Logger
	PublicURL string
	Now       func() time.Time
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Service{q: o.Q, files: o.Files, log: o.Log, publicURL: o.PublicURL, now: o.Now}
}

// ---------------------------------------------------------------- management (needs full)

// List returns the active share links of a page. Needs `full`.
func (s *Service) List(ctx context.Context, userID, pageID uuid.UUID) ([]gen.ShareLink, error) {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.Full); err != nil {
		return nil, err
	}
	rows, err := s.q.ListShareLinks(ctx, pageID)
	if err != nil {
		return nil, fmt.Errorf("list share links: %w", err)
	}
	out := make([]gen.ShareLink, 0, len(rows))
	for _, r := range rows {
		out = append(out, s.toShareLink(r))
	}
	return out, nil
}

// Create makes a public link for a page. Needs `full`.
func (s *Service) Create(ctx context.Context, userID, pageID uuid.UUID, includeSubpages bool) (gen.ShareLink, error) {
	if _, err := perm.Require(ctx, s.q, userID, pageID, perm.Full); err != nil {
		return gen.ShareLink{}, err
	}
	token, err := newToken()
	if err != nil {
		return gen.ShareLink{}, fmt.Errorf("generate token: %w", err)
	}
	link, err := s.q.InsertShareLink(ctx, sqlcgen.InsertShareLinkParams{
		PageID: pageID, Token: token, IncludeSubpages: includeSubpages, CreatedBy: &userID,
	})
	if err != nil {
		return gen.ShareLink{}, fmt.Errorf("insert share link: %w", err)
	}
	return s.toShareLink(link), nil
}

// Update toggles includeSubpages. Needs `full` on the link's page.
func (s *Service) Update(ctx context.Context, userID, shareID uuid.UUID, includeSubpages *bool) (gen.ShareLink, error) {
	link, err := s.authorizedLink(ctx, userID, shareID)
	if err != nil {
		return gen.ShareLink{}, err
	}
	val := link.IncludeSubpages
	if includeSubpages != nil {
		val = *includeSubpages
	}
	updated, err := s.q.UpdateShareLink(ctx, sqlcgen.UpdateShareLinkParams{ID: shareID, IncludeSubpages: val})
	if err != nil {
		return gen.ShareLink{}, fmt.Errorf("update share link: %w", err)
	}
	return s.toShareLink(updated), nil
}

// Revoke disables a link. Needs `full` on the link's page.
func (s *Service) Revoke(ctx context.Context, userID, shareID uuid.UUID) error {
	if _, err := s.authorizedLink(ctx, userID, shareID); err != nil {
		return err
	}
	if _, err := s.q.RevokeShareLink(ctx, shareID); err != nil {
		return fmt.Errorf("revoke share link: %w", err)
	}
	return nil
}

func (s *Service) authorizedLink(ctx context.Context, userID, shareID uuid.UUID) (sqlcgen.ShareLink, error) {
	link, err := s.q.GetShareLink(ctx, shareID)
	if err != nil {
		if db.IsNotFound(err) {
			return sqlcgen.ShareLink{}, apperr.NotFound("Share link not found.")
		}
		return sqlcgen.ShareLink{}, fmt.Errorf("get share link: %w", err)
	}
	if _, err := perm.Require(ctx, s.q, userID, link.PageID, perm.Full); err != nil {
		return sqlcgen.ShareLink{}, err
	}
	return link, nil
}

// ---------------------------------------------------------------- public

// PublicRoot returns the shared root page (read-only).
func (s *Service) PublicRoot(ctx context.Context, token string) (gen.PublicPage, error) {
	link, err := s.linkByToken(ctx, token)
	if err != nil {
		return gen.PublicPage{}, err
	}
	return s.buildPublicPage(ctx, link, link.PageID)
}

// PublicSubpage returns a descendant of the shared page (only when includeSubpages is set).
func (s *Service) PublicSubpage(ctx context.Context, token string, pageID uuid.UUID) (gen.PublicPage, error) {
	link, err := s.linkByToken(ctx, token)
	if err != nil {
		return gen.PublicPage{}, err
	}
	if pageID != link.PageID {
		if !link.IncludeSubpages {
			return gen.PublicPage{}, apperr.NotFound("Page not found.")
		}
		inside, err := s.q.IsInSubtree(ctx, sqlcgen.IsInSubtreeParams{ID: link.PageID, CandidateID: pageID})
		if err != nil {
			return gen.PublicPage{}, fmt.Errorf("subtree check: %w", err)
		}
		if !inside {
			return gen.PublicPage{}, apperr.NotFound("Page not found.")
		}
	}
	return s.buildPublicPage(ctx, link, pageID)
}

// PublicFile serves a file attached within the shared subtree.
func (s *Service) PublicFile(ctx context.Context, token string, fileID uuid.UUID) (sqlcgen.Attachment, error) {
	link, err := s.linkByToken(ctx, token)
	if err != nil {
		return sqlcgen.Attachment{}, err
	}
	att, err := s.files.Get(ctx, fileID)
	if err != nil {
		return sqlcgen.Attachment{}, err
	}
	if att.PageID == nil {
		return sqlcgen.Attachment{}, apperr.NotFound("File not found.")
	}
	if *att.PageID == link.PageID {
		return att, nil
	}
	if !link.IncludeSubpages {
		return sqlcgen.Attachment{}, apperr.NotFound("File not found.")
	}
	inside, err := s.q.IsInSubtree(ctx, sqlcgen.IsInSubtreeParams{ID: link.PageID, CandidateID: *att.PageID})
	if err != nil {
		return sqlcgen.Attachment{}, fmt.Errorf("subtree check: %w", err)
	}
	if !inside {
		return sqlcgen.Attachment{}, apperr.NotFound("File not found.")
	}
	return att, nil
}

func (s *Service) linkByToken(ctx context.Context, token string) (sqlcgen.ShareLink, error) {
	link, err := s.q.GetShareLinkByToken(ctx, token)
	if err != nil {
		if db.IsNotFound(err) {
			return sqlcgen.ShareLink{}, apperr.NotFound("This share link is invalid or has been revoked.")
		}
		return sqlcgen.ShareLink{}, fmt.Errorf("get share link by token: %w", err)
	}
	return link, nil
}

func (s *Service) buildPublicPage(ctx context.Context, link sqlcgen.ShareLink, pageID uuid.UUID) (gen.PublicPage, error) {
	data, err := s.q.GetPublicPageData(ctx, pageID)
	if err != nil {
		if db.IsNotFound(err) {
			return gen.PublicPage{}, apperr.NotFound("Page not found.")
		}
		return gen.PublicPage{}, fmt.Errorf("get public page: %w", err)
	}
	blocks := []map[string]any{}
	if len(data.Blocks) > 0 {
		if err := json.Unmarshal(data.Blocks, &blocks); err != nil {
			s.log.Warn("stored blocks are not valid JSON", "page", pageID, "err", err)
			blocks = []map[string]any{}
		}
	}
	// Page links may only point inside the shared subtree; everything else is replaced so the titles of
	// unshared pages never leak through a public page.
	allowed := map[string]bool{strings.ToLower(link.PageID.String()): true}
	var subtree []sqlcgen.ListPublicSubtreeRow
	if link.IncludeSubpages {
		rows, err := s.q.ListPublicSubtree(ctx, link.PageID)
		if err != nil {
			return gen.PublicPage{}, fmt.Errorf("public subtree: %w", err)
		}
		subtree = rows
		for _, r := range rows {
			allowed[strings.ToLower(r.ID.String())] = true
		}
	}
	for i := range blocks {
		if b, ok := sanitizePageLinks(map[string]any(blocks[i]), allowed).(map[string]any); ok {
			blocks[i] = b
		}
	}
	out := gen.PublicPage{
		Page:            meta(data.ID, data.ParentID, data.Title, data.Icon, data.Cover),
		Blocks:          blocks,
		RootPageId:      link.PageID,
		IncludeSubpages: link.IncludeSubpages,
		UpdatedAt:       data.ContentUpdatedAt,
		Tree:            []gen.PublicPageMeta{},
	}
	if link.IncludeSubpages {
		for _, r := range subtree {
			out.Tree = append(out.Tree, meta(r.ID, r.ParentID, r.Title, r.Icon, r.Cover))
		}
	} else {
		out.Tree = append(out.Tree, out.Page)
	}
	return out, nil
}

func meta(id uuid.UUID, parentID *uuid.UUID, title string, icon, cover *string) gen.PublicPageMeta {
	return gen.PublicPageMeta{Id: id, ParentId: parentID, Title: title, Icon: icon, Cover: cover}
}

func (s *Service) toShareLink(l sqlcgen.ShareLink) gen.ShareLink {
	return gen.ShareLink{
		Id: l.ID, PageId: l.PageID, Token: l.Token, Url: s.publicURL + "/s/" + l.Token,
		IncludeSubpages: l.IncludeSubpages, CreatedAt: l.CreatedAt, RevokedAt: l.RevokedAt,
	}
}

func newToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
