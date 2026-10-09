package transfer

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"hostidian/backend/internal/apperr"
)

// A zip whose entries declare more decompressed data than the importer accepts is rejected before
// anything is read, so a small upload cannot expand into memory or disk.
func TestProcessZipRejectsOversizedDeclaredTotal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bomb.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, name := range []string{"a.bin", "b.bin"} {
		// CreateRaw lets us write a header with an arbitrary declared size and no payload.
		w, err := zw.CreateRaw(&zip.FileHeader{Name: name, Method: zip.Store, UncompressedSize64: 3 << 30})
		if err != nil {
			t.Fatal(err)
		}
		_ = w
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	_, err = (&Service{}).processZip(context.Background(), uuid.New(), uuid.New(), nil, path, uuid.New())
	if err == nil {
		t.Fatal("expected the oversized zip to be rejected")
	}
	var ae *apperr.Error
	if !errors.As(err, &ae) || ae.Code != "bad_request" {
		t.Fatalf("want a bad_request error, got %v", err)
	}
}
