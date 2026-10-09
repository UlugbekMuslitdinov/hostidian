package files

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

const (
	sweepBatch = 200
	sweepMax   = 2000 // per run, so a huge backlog never monopolises the janitor
)

// Sweep deletes attachments that no page references (rows and files) and files on disk that have no
// attachment row, once they are older than minAge. The age guard protects uploads whose page content has
// not been extracted yet. It returns the number of removed files.
func (s *Service) Sweep(ctx context.Context, minAge time.Duration) (int, error) {
	removed := 0
	for removed < sweepMax {
		rows, err := s.q.ListUnreferencedAttachments(ctx, listUnreferencedParams(minAge))
		if err != nil {
			return removed, err
		}
		if len(rows) == 0 {
			break
		}
		ids := make([]uuid.UUID, 0, len(rows))
		for _, r := range rows {
			if abs, err := s.pathFor(r.StorageKey); err == nil {
				if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
					s.log.Warn("sweep: remove file", "id", r.ID, "err", err)
				}
			}
			ids = append(ids, r.ID)
		}
		if err := s.q.DeleteAttachmentsByIDs(ctx, ids); err != nil {
			return removed, err
		}
		removed += len(ids)
	}
	n, err := s.sweepOrphanFiles(ctx, minAge)
	return removed + n, err
}

// sweepOrphanFiles removes stored files whose id has no attachment row (e.g. the workspace was deleted).
func (s *Service) sweepOrphanFiles(ctx context.Context, minAge time.Duration) (int, error) {
	root := filepath.Join(s.dir, "files")
	cutoff := time.Now().Add(-minAge)
	type cand struct {
		id   uuid.UUID
		path string
	}
	var batch []cand
	removed := 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		ids := make([]uuid.UUID, len(batch))
		for i, c := range batch {
			ids[i] = c.id
		}
		rows, err := s.q.ListAttachmentsByIDs(ctx, ids)
		if err != nil {
			return err
		}
		known := make(map[uuid.UUID]bool, len(rows))
		for _, r := range rows {
			known[r.ID] = true
		}
		for _, c := range batch {
			if !known[c.id] {
				if err := os.Remove(c.path); err == nil {
					removed++
				}
			}
		}
		batch = batch[:0]
		return nil
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() || removed >= sweepMax {
			return nil
		}
		id, perr := uuid.Parse(d.Name())
		if perr != nil {
			return nil // not one of ours
		}
		info, ierr := d.Info()
		if ierr != nil || info.ModTime().After(cutoff) {
			return nil
		}
		batch = append(batch, cand{id: id, path: p})
		if len(batch) >= sweepBatch {
			return flush()
		}
		return nil
	})
	if err != nil {
		return removed, err
	}
	return removed, flush()
}
