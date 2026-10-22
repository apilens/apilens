package apikeys

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

type fakeLookup struct {
	mu      sync.Mutex
	keys    map[string]db.GetActiveAPIKeyByHashRow
	calls   atomic.Int32
	touched atomic.Int32
	err     error
}

func (f *fakeLookup) GetActiveAPIKeyByHash(_ context.Context, h string) (db.GetActiveAPIKeyByHashRow, error) {
	f.calls.Add(1)
	time.Sleep(5 * time.Millisecond) // widen the singleflight window
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return db.GetActiveAPIKeyByHashRow{}, f.err
	}
	row, ok := f.keys[h]
	if !ok {
		return db.GetActiveAPIKeyByHashRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func (f *fakeLookup) TouchAPIKey(context.Context, uuid.UUID) error {
	f.touched.Add(1)
	return nil
}

func newVerifier(f *fakeLookup) *Verifier {
	return NewVerifier(f, Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute, TouchInterval: time.Hour},
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
}

func TestGenerateAndHash(t *testing.T) {
	raw, prefix, hash, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(raw, Prefix) || len(raw) != len(Prefix)+43 {
		t.Fatalf("raw = %q", raw)
	}
	if prefix != raw[:16] || hash != Hash(raw) || len(hash) != 64 {
		t.Fatalf("prefix/hash mismatch")
	}
	if !WellFormed(raw) || !WellFormed("apilens_"+strings.Repeat("x", 54)) {
		t.Fatal("expected well-formed")
	}
	for _, bad := range []string{"", "short", "Bearer apl_live_x", "nope_" + strings.Repeat("x", 40), strings.Repeat("a", 300)} {
		if WellFormed(bad) {
			t.Errorf("WellFormed(%q) = true", bad)
		}
	}
}

func TestVerifyCachesAndSingleflights(t *testing.T) {
	raw, _, hash, _ := Generate()
	pid := uuid.New()
	f := &fakeLookup{keys: map[string]db.GetActiveAPIKeyByHashRow{
		hash: {ID: uuid.New(), ProjectID: pid, ProjectSlug: "shop", Scopes: []string{"ingest"}},
	}}
	v := newVerifier(f)

	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, err := v.Verify(context.Background(), raw)
			if err != nil || p.ProjectID != pid || !p.HasScope("ingest") {
				t.Errorf("verify = %+v %v", p, err)
			}
		}()
	}
	wg.Wait()
	if _, err := v.Verify(context.Background(), raw); err != nil {
		t.Fatal(err)
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("lookups = %d, want 1 (cache + singleflight)", n)
	}
	time.Sleep(20 * time.Millisecond)
	if n := f.touched.Load(); n != 1 {
		t.Fatalf("touches = %d, want 1 (debounced)", n)
	}
}

func TestVerifyNegativeCacheAndInvalidate(t *testing.T) {
	raw, _, hash, _ := Generate()
	f := &fakeLookup{keys: map[string]db.GetActiveAPIKeyByHashRow{}}
	v := newVerifier(f)

	for range 3 {
		if _, err := v.Verify(context.Background(), raw); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("err = %v", err)
		}
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("lookups = %d, want 1 (negative cache)", n)
	}

	// Key gets created; invalidation makes it visible immediately.
	f.mu.Lock()
	f.keys[hash] = db.GetActiveAPIKeyByHashRow{ID: uuid.New(), ProjectID: uuid.New()}
	f.mu.Unlock()
	v.Invalidate(hash)
	if _, err := v.Verify(context.Background(), raw); err != nil {
		t.Fatalf("after invalidate: %v", err)
	}
}

func TestVerifyMalformedSkipsLookup(t *testing.T) {
	f := &fakeLookup{}
	v := newVerifier(f)
	if _, err := v.Verify(context.Background(), "garbage"); !errors.Is(err, ErrInvalidKey) {
		t.Fatal(err)
	}
	if f.calls.Load() != 0 {
		t.Fatal("malformed key should not hit the store")
	}
}

func TestVerifyStoreErrorIsNotInvalidKey(t *testing.T) {
	raw, _, _, _ := Generate()
	f := &fakeLookup{err: errors.New("connection refused")}
	v := newVerifier(f)
	_, err := v.Verify(context.Background(), raw)
	if err == nil || errors.Is(err, ErrInvalidKey) {
		t.Fatalf("err = %v, want a datastore error", err)
	}
}
