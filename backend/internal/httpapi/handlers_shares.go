package httpapi

import (
	"net/http"

	"github.com/google/uuid"

	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/shares"
)

func sharesService(s *Server) *shares.Service {
	return Ext(s, "shares", func() *shares.Service {
		return shares.NewService(shares.Options{
			Q: s.Deps.Q, Files: filesService(s), Log: s.Log, PublicURL: s.Config.PublicURL,
		})
	})
}

// ListShareLinks: GET /pages/{pageId}/shares
func (s *Server) ListShareLinks(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := sharesService(s).List(r.Context(), p.User.ID, uuid.UUID(pageId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateShareLink: POST /pages/{pageId}/shares
func (s *Server) CreateShareLink(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	include := false
	if body, err := decodeJSON[gen.CreateShareLinkJSONBody](w, r); err == nil {
		if body.IncludeSubpages != nil {
			include = *body.IncludeSubpages
		}
	} else if err != errEmptyBody {
		s.writeError(w, r, err)
		return
	}
	out, err := sharesService(s).Create(r.Context(), p.User.ID, uuid.UUID(pageId), include)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// UpdateShareLink: PATCH /shares/{shareId}
func (s *Server) UpdateShareLink(w http.ResponseWriter, r *http.Request, shareId uuid.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	body, err := decodeJSON[gen.UpdateShareLinkJSONBody](w, r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out, err := sharesService(s).Update(r.Context(), p.User.ID, uuid.UUID(shareId), body.IncludeSubpages)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// RevokeShareLink: DELETE /shares/{shareId}
func (s *Server) RevokeShareLink(w http.ResponseWriter, r *http.Request, shareId uuid.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	if err := sharesService(s).Revoke(r.Context(), p.User.ID, uuid.UUID(shareId)); err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}

// GetPublicPage: GET /public/{token}/page
func (s *Server) GetPublicPage(w http.ResponseWriter, r *http.Request, token gen.ShareToken) {
	out, err := sharesService(s).PublicRoot(r.Context(), token)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetPublicSubpage: GET /public/{token}/pages/{pageId}
func (s *Server) GetPublicSubpage(w http.ResponseWriter, r *http.Request, token gen.ShareToken, pageId gen.PageId) {
	out, err := sharesService(s).PublicSubpage(r.Context(), token, uuid.UUID(pageId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DownloadPublicFile: GET /public/{token}/files/{fileId}
func (s *Server) DownloadPublicFile(w http.ResponseWriter, r *http.Request, token gen.ShareToken, fileId gen.FileId) {
	att, err := sharesService(s).PublicFile(r.Context(), token, uuid.UUID(fileId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := filesService(s).Serve(w, r, att); err != nil {
		s.writeError(w, r, err)
	}
}
