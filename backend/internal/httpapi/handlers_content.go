package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/content"
	"hostidian/backend/internal/httpapi/gen"
)

func contentService(s *Server) *content.Service {
	return Ext(s, "content", func() *content.Service {
		return content.NewService(content.Options{Q: s.Deps.Q, Pool: s.Pool, Broker: s.Broker, Log: s.Log})
	})
}

// GetPageContent: GET /pages/{pageId}/content
func (s *Server) GetPageContent(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := contentService(s).GetPageContent(r.Context(), p.User.ID, uuid.UUID(pageId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetBacklinks: GET /pages/{pageId}/backlinks
func (s *Server) GetBacklinks(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := contentService(s).Backlinks(r.Context(), p.User.ID, uuid.UUID(pageId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetGraph: GET /workspaces/{workspaceId}/graph
func (s *Server) GetGraph(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	out, err := contentService(s).Graph(r.Context(), p.User.ID, uuid.UUID(workspaceId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Search: GET /workspaces/{workspaceId}/search
func (s *Server) Search(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId, params gen.SearchParams) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	mode := content.ModeFull
	if params.Mode != nil {
		switch *params.Mode {
		case gen.SearchParamsModeTitle:
			mode = content.ModeTitle
		case gen.SearchParamsModeFull:
			mode = content.ModeFull
		}
	}
	limit := 20
	if params.Limit != nil {
		limit = *params.Limit
	}
	out, err := contentService(s).Search(r.Context(), p.User.ID, uuid.UUID(workspaceId), params.Q, mode, limit)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// internalIngestBody is the body of PUT /internal/pages/{pageId}/content.
type internalIngestBody struct {
	Markdown    string          `json:"markdown"`
	Plaintext   string          `json:"plaintext"`
	Blocks      json.RawMessage `json:"blocks"`
	LinkTargets []uuid.UUID     `json:"linkTargets"`
	EditorIds   []uuid.UUID     `json:"editorIds"`
}

func init() {
	RegisterInternalRoutes(func(s *Server, r chi.Router) {
		r.Put("/pages/{pageId}/content", s.putPageContent)
	})
}

// putPageContent: PUT /internal/pages/{pageId}/content (collab → api).
func (s *Server) putPageContent(w http.ResponseWriter, r *http.Request) {
	pageID, err := uuid.Parse(chi.URLParam(r, "pageId"))
	if err != nil {
		writeAppError(w, apperr.BadRequest("Invalid pageId."))
		return
	}
	var body internalIngestBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(&body); err != nil {
		writeAppError(w, apperr.BadRequest("The request body is not valid JSON."))
		return
	}
	err = contentService(s).Ingest(r.Context(), pageID, content.IngestInput{
		Markdown: body.Markdown, Plaintext: body.Plaintext, Blocks: body.Blocks,
		LinkTargets: body.LinkTargets, EditorIDs: body.EditorIds,
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	noContent(w)
}
