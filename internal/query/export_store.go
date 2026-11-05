package query

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

// LocalExportStore keeps export files in a local directory: the export
// store of a single-VM install. Files are written to a temporary name and
// renamed into place, so a reader never sees a partial file.
type LocalExportStore struct {
	dir string
}

// exportKey is the shape of the keys exports use: <uuid>.csv.gz.
var exportKey = regexp.MustCompile(`^[0-9a-f-]{36}\.csv\.gz$`)

// NewLocalExportStore keeps files in dir, creating it (mode 0700) when
// missing. An empty dir means apilens-exports under the OS temp directory.
func NewLocalExportStore(dir string) (*LocalExportStore, error) {
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "apilens-exports")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("exports: %w", err)
	}
	return &LocalExportStore{dir: dir}, nil
}

func (s *LocalExportStore) path(key string) (string, error) {
	if !exportKey.MatchString(key) {
		return "", fmt.Errorf("exports: invalid key %q", key)
	}
	return filepath.Join(s.dir, key), nil
}

// Write implements ExportStore.
func (s *LocalExportStore) Write(_ context.Context, key string, fill func(io.Writer) error) (int64, error) {
	dst, err := s.path(key)
	if err != nil {
		return 0, err
	}
	f, err := os.CreateTemp(s.dir, key+".*.part")
	if err != nil {
		return 0, fmt.Errorf("exports: %w", err)
	}
	tmp := f.Name()
	done := false
	defer func() {
		if !done {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	cw := &countingWriter{w: f}
	if err := fill(cw); err != nil {
		return 0, err
	}
	if err := f.Sync(); err != nil {
		return 0, fmt.Errorf("exports: %w", err)
	}
	if err := f.Close(); err != nil {
		return 0, fmt.Errorf("exports: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		done = true
		return 0, fmt.Errorf("exports: %w", err)
	}
	done = true
	return cw.n, nil
}

// Open implements ExportStore.
func (s *LocalExportStore) Open(_ context.Context, key string) (io.ReadCloser, int64, error) {
	p, err := s.path(key)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(p) //nolint:gosec // p is a validated key inside the store's directory
	if err != nil {
		return nil, 0, fmt.Errorf("exports: %w", err)
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, fmt.Errorf("exports: %w", err)
	}
	return f, st.Size(), nil
}

// Remove implements ExportStore.
func (s *LocalExportStore) Remove(_ context.Context, key string) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("exports: %w", err)
	}
	return nil
}

type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}
