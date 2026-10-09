// Package files stores and serves attachments on local disk (conventions §7).
//
// Attachment ids are random UUIDv4 (capability-style URLs). Storage lives under
// $DATA_DIR/files/<aa>/<id> where <aa> is the first two hex characters of the id. Content types are
// sniffed server-side; only a small allowlist may be served inline.
package files

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
)

// Service stores and serves files.
type Service struct {
	q         *sqlcgen.Queries
	log       *slog.Logger
	dir       string
	maxUpload int64
}

// Options configure NewService.
type Options struct {
	Q           *sqlcgen.Queries
	Log         *slog.Logger
	DataDir     string
	MaxUploadMB int
}

func NewService(o Options) *Service {
	max := int64(o.MaxUploadMB) << 20
	if max <= 0 {
		max = 50 << 20
	}
	return &Service{q: o.Q, log: o.Log, dir: o.DataDir, maxUpload: max}
}

// MaxUploadBytes is the largest accepted upload.
func (s *Service) MaxUploadBytes() int64 { return s.maxUpload }

// Upload stores an uploaded file. pageID, when given, must be editable by the caller; otherwise the
// caller must be a non-guest member of the workspace. fh is the parsed multipart file.
func (s *Service) Upload(ctx context.Context, userID, workspaceID uuid.UUID, pageID *uuid.UUID, fh *multipart.FileHeader) (gen.Attachment, error) {
	var acc perm.Access
	if pageID != nil {
		a, err := perm.Require(ctx, s.q, userID, *pageID, perm.Edit)
		if err != nil {
			return gen.Attachment{}, err
		}
		if a.WorkspaceID != workspaceID {
			return gen.Attachment{}, perm.ErrPageNotFound
		}
		acc = a
	} else {
		role, err := perm.RequireMember(ctx, s.q, workspaceID, userID)
		if err != nil {
			return gen.Attachment{}, err
		}
		if role == perm.Guest {
			return gen.Attachment{}, apperr.Forbidden("Guests must attach files to a shared page.")
		}
	}
	if fh.Size > s.maxUpload {
		return gen.Attachment{}, apperr.PayloadTooLarge(fmt.Sprintf("Files must be at most %d MB.", s.maxUpload>>20))
	}

	src, err := fh.Open()
	if err != nil {
		return gen.Attachment{}, fmt.Errorf("open upload: %w", err)
	}
	defer src.Close()

	id, err := uuid.NewRandom()
	if err != nil {
		return gen.Attachment{}, fmt.Errorf("new attachment id: %w", err)
	}
	key := storageKey(id)
	abs, err := s.pathFor(key)
	if err != nil {
		return gen.Attachment{}, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return gen.Attachment{}, fmt.Errorf("create file dir: %w", err)
	}

	// Read the head to sniff the content type, then stream the rest to disk.
	head := make([]byte, 512)
	n, err := io.ReadFull(src, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return gen.Attachment{}, fmt.Errorf("read upload head: %w", err)
	}
	head = head[:n]
	contentType := http.DetectContentType(head)

	dst, err := os.OpenFile(abs, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o644)
	if err != nil {
		return gen.Attachment{}, fmt.Errorf("create file: %w", err)
	}
	size, copyErr := io.Copy(dst, io.MultiReader(strings.NewReader(string(head)), io.LimitReader(src, s.maxUpload+1)))
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(abs)
		return gen.Attachment{}, fmt.Errorf("write file: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(abs)
		return gen.Attachment{}, fmt.Errorf("close file: %w", closeErr)
	}
	if size > s.maxUpload {
		_ = os.Remove(abs)
		return gen.Attachment{}, apperr.PayloadTooLarge(fmt.Sprintf("Files must be at most %d MB.", s.maxUpload>>20))
	}

	var pid *uuid.UUID
	if pageID != nil {
		pid = pageID
	}
	att, err := s.q.InsertAttachment(ctx, sqlcgen.InsertAttachmentParams{
		ID: id, WorkspaceID: workspaceID, PageID: pid, UploadedBy: &userID,
		Filename: sanitizeFilename(fh.Filename), ContentType: contentType, SizeBytes: size, StorageKey: key,
	})
	if err != nil {
		_ = os.Remove(abs)
		return gen.Attachment{}, fmt.Errorf("insert attachment: %w", err)
	}
	_ = acc
	return ToAttachment(att), nil
}

// StoreBytes writes an in-memory blob (used by the importer) and records it. Content types are
// sniffed; the caller is responsible for having authorized the page/workspace.
func (s *Service) StoreBytes(ctx context.Context, workspaceID, userID uuid.UUID, pageID *uuid.UUID, filename string, data []byte) (sqlcgen.Attachment, error) {
	if int64(len(data)) > s.maxUpload {
		return sqlcgen.Attachment{}, apperr.PayloadTooLarge(fmt.Sprintf("Files must be at most %d MB.", s.maxUpload>>20))
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return sqlcgen.Attachment{}, fmt.Errorf("new attachment id: %w", err)
	}
	key := storageKey(id)
	abs, err := s.pathFor(key)
	if err != nil {
		return sqlcgen.Attachment{}, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return sqlcgen.Attachment{}, fmt.Errorf("create file dir: %w", err)
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return sqlcgen.Attachment{}, fmt.Errorf("write file: %w", err)
	}
	head := data
	if len(head) > 512 {
		head = head[:512]
	}
	att, err := s.q.InsertAttachment(ctx, sqlcgen.InsertAttachmentParams{
		ID: id, WorkspaceID: workspaceID, PageID: pageID, UploadedBy: &userID,
		Filename: sanitizeFilename(filename), ContentType: http.DetectContentType(head),
		SizeBytes: int64(len(data)), StorageKey: key,
	})
	if err != nil {
		_ = os.Remove(abs)
		return sqlcgen.Attachment{}, fmt.Errorf("insert attachment: %w", err)
	}
	return att, nil
}

// Get loads an attachment row by id.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (sqlcgen.Attachment, error) {
	att, err := s.q.GetAttachment(ctx, id)
	if err != nil {
		if db.IsNotFound(err) {
			return sqlcgen.Attachment{}, apperr.NotFound("File not found.")
		}
		return sqlcgen.Attachment{}, fmt.Errorf("get attachment: %w", err)
	}
	return att, nil
}

// Authorize checks a logged-in caller's read access to an attachment (conventions §7): a non-guest
// member of the workspace, or a guest with at least `view` on the attachment's page.
func (s *Service) Authorize(ctx context.Context, userID uuid.UUID, att sqlcgen.Attachment) error {
	role, ok, err := perm.MemberRole(ctx, s.q, att.WorkspaceID, userID)
	if err != nil {
		return err
	}
	if ok && role != perm.Guest {
		return nil
	}
	if att.PageID != nil {
		if _, err := perm.Require(ctx, s.q, userID, *att.PageID, perm.View); err == nil {
			return nil
		}
	}
	return apperr.NotFound("File not found.")
}

// Serve streams an attachment. It sets nosniff and an inline disposition only for a safe allowlist;
// everything else is forced to download. Range and ETag are handled by http.ServeContent.
func (s *Service) Serve(w http.ResponseWriter, r *http.Request, att sqlcgen.Attachment) error {
	abs, err := s.pathFor(att.StorageKey)
	if err != nil {
		return err
	}
	f, err := os.Open(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return apperr.NotFound("File not found.")
		}
		return fmt.Errorf("open stored file: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat stored file: %w", err)
	}

	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Type", att.ContentType)
	h.Set("ETag", `"`+att.ID.String()+`"`)
	disposition := "attachment"
	if inlineAllowed(att.ContentType) {
		disposition = "inline"
	}
	h.Set("Content-Disposition", disposition+`; filename="`+headerSafe(att.Filename)+`"`)
	http.ServeContent(w, r, att.Filename, info.ModTime(), f)
	return nil
}

// AbsPath returns the absolute path of a stored file (used by the exporter).
func (s *Service) AbsPath(key string) (string, error) { return s.pathFor(key) }

// pathFor joins the relative storage key to the data dir, guarding against traversal.
func (s *Service) pathFor(key string) (string, error) {
	clean := filepath.Clean(key)
	if filepath.IsAbs(clean) || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return "", apperr.Internal(fmt.Errorf("invalid storage key %q", key))
	}
	return filepath.Join(s.dir, "files", clean), nil
}

func storageKey(id uuid.UUID) string {
	hex := strings.ReplaceAll(id.String(), "-", "")
	return filepath.Join(hex[:2], id.String())
}

// ToAttachment renders the API shape (relative URL, no query).
func ToAttachment(a sqlcgen.Attachment) gen.Attachment {
	return gen.Attachment{
		Id:          a.ID,
		Url:         "/api/files/" + a.ID.String(),
		Filename:    a.Filename,
		ContentType: a.ContentType,
		SizeBytes:   a.SizeBytes,
	}
}

func inlineAllowed(contentType string) bool {
	ct := contentType
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	ct = strings.TrimSpace(strings.ToLower(ct))
	switch ct {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
		"video/mp4", "video/webm", "application/pdf":
		return true
	}
	return strings.HasPrefix(ct, "audio/")
}

// sanitizeFilename keeps the base name only, strips control characters and trailing dots/spaces, and
// caps the length.
func sanitizeFilename(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimRight(name, ". ")
	if name == "" || name == "." {
		name = "file"
	}
	if utf8.RuneCountInString(name) > 200 {
		runes := []rune(name)
		name = string(runes[:200])
	}
	return name
}

// headerSafe removes characters that could break out of the Content-Disposition value.
func headerSafe(name string) string {
	return strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
}
