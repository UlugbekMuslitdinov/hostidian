package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/files"
	"hostidian/backend/internal/httpapi/gen"
)

// filesService lazily builds the wave-2 files service (wired through Server.Ext so server.go stays
// untouched).
func filesService(s *Server) *files.Service {
	return Ext(s, "files", func() *files.Service {
		return files.NewService(files.Options{
			Q: s.Deps.Q, Log: s.Log, DataDir: s.Config.DataDir, MaxUploadMB: s.Config.MaxUploadMB,
		})
	})
}

// SweepFiles removes unreferenced attachments older than minAge and orphaned files on disk (janitor).
func (s *Server) SweepFiles(ctx context.Context, minAge time.Duration) (int, error) {
	return filesService(s).Sweep(ctx, minAge)
}

// UploadFile: POST /workspaces/{workspaceId}/files
func (s *Server) UploadFile(w http.ResponseWriter, r *http.Request, workspaceId gen.WorkspaceId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc := filesService(s)
	// Give the multipart reader a hard ceiling (file bytes plus a small form overhead).
	r.Body = http.MaxBytesReader(w, r.Body, svc.MaxUploadBytes()+(1<<20))
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			s.writeError(w, r, apperr.PayloadTooLarge("The file is too large."))
			return
		}
		s.writeError(w, r, apperr.BadRequest("Expected a multipart form with a `file` field."))
		return
	}
	fhs := r.MultipartForm.File["file"]
	if len(fhs) == 0 {
		s.writeError(w, r, fieldRequired("file"))
		return
	}
	var pageID *uuid.UUID
	if raw := r.FormValue("pageId"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			s.writeError(w, r, apperr.FieldError("pageId", "Must be a valid UUID."))
			return
		}
		pageID = &id
	}
	att, err := svc.Upload(r.Context(), p.User.ID, uuid.UUID(workspaceId), pageID, fhs[0])
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, att)
}

// DownloadFile: GET /files/{fileId}
func (s *Server) DownloadFile(w http.ResponseWriter, r *http.Request, fileId gen.FileId) {
	p, ok := s.requireUser(w, r)
	if !ok {
		return
	}
	svc := filesService(s)
	att, err := svc.Get(r.Context(), uuid.UUID(fileId))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := svc.Authorize(r.Context(), p.User.ID, att); err != nil {
		s.writeError(w, r, err)
		return
	}
	if err := svc.Serve(w, r, att); err != nil {
		s.writeError(w, r, err)
	}
}
