package httpapi

import (
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/transfer"
)

func transferService(s *Server) *transfer.Service {
	return Ext(s, "transfer", func() *transfer.Service {
		var importer collabclient.Importer = collabclient.Noop{}
		if c, ok := s.Collab.(collabclient.Importer); ok {
			importer = c
		}
		return transfer.NewService(transfer.Options{
			Pool: s.Pool, Q: s.Deps.Q, Log: s.Log, Collab: importer, Files: filesService(s), DataDir: s.Config.DataDir,
		})
	})
}

// ExportPage: GET /pages/{pageId}/export
func (s *Server) ExportPage(w http.ResponseWriter, r *http.Request, pageId gen.PageId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	name, data, err := transferService(s).ExportPage(r.Context(), p.User.ID, uuid.UUID(pageId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeZip(w, name, data)
}

// ExportWorkspace: GET /workspaces/{workspaceId}/export
func (s *Server) ExportWorkspace(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	name, data, err := transferService(s).ExportWorkspace(r.Context(), p.User.ID, uuid.UUID(workspaceId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeZip(w, name, data)
}

// ImportZip: POST /workspaces/{workspaceId}/import
func (s *Server) ImportZip(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc := transferService(s)
	r.Body = http.MaxBytesReader(w, r.Body, int64(s.Config.MaxImportMB)<<20+(1<<20))
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		s.writeError(w, r, apperr.BadRequest("Expected a multipart form with a `file` field."))
		return
	}
	fhs := r.MultipartForm.File["file"]
	if len(fhs) == 0 {
		s.writeError(w, r, fieldRequired("file"))
		return
	}
	var parentID *uuid.UUID
	if raw := r.FormValue("parentId"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			s.writeError(w, r, apperr.FieldError("parentId", "Must be a valid UUID."))
			return
		}
		parentID = &id
	}
	job, err := svc.StartImport(r.Context(), p.User.ID, uuid.UUID(workspaceId), parentID, fhs[0])
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job)
}

// GetImportJob: GET /import-jobs/{jobId}
func (s *Server) GetImportJob(w http.ResponseWriter, r *http.Request, jobId uuid.UUID) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	job, err := transferService(s).GetImportJob(r.Context(), p.User.ID, uuid.UUID(jobId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func writeZip(w http.ResponseWriter, name string, data []byte) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
