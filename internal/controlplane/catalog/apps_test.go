package catalog

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

type fakeApps struct {
	mu    sync.Mutex
	rows  []db.ListProjectAppsRow
	calls int
}

func (f *fakeApps) ListProjectApps(context.Context, uuid.UUID) ([]db.ListProjectAppsRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return append([]db.ListProjectAppsRow(nil), f.rows...), nil
}

func TestResolveSlugsAndIDs(t *testing.T) {
	shop, api := uuid.New(), uuid.New()
	f := &fakeApps{rows: []db.ListProjectAppsRow{{ID: shop, Slug: "shop"}, {ID: api, Slug: "api"}}}
	r := NewAppResolver(f, time.Minute)

	got, err := r.Resolve(context.Background(), uuid.New(), []string{"shop", api.String(), "shop"})
	if err != nil {
		t.Fatal(err)
	}
	if got["shop"] != shop || got[api.String()] != api {
		t.Fatalf("got %v", got)
	}
	if _, err := r.Resolve(context.Background(), uuid.New(), []string{"api"}); err != nil {
		t.Fatal(err)
	}
}

func TestResolveUnknownRefreshesOnce(t *testing.T) {
	f := &fakeApps{rows: []db.ListProjectAppsRow{{ID: uuid.New(), Slug: "shop"}}}
	r := NewAppResolver(f, time.Minute)
	r.minRefresh = 0
	pid := uuid.New()

	_, err := r.Resolve(context.Background(), pid, []string{"shop", "ghost", uuid.NewString()})
	var unknown *UnknownAppsError
	if !errors.As(err, &unknown) || len(unknown.Identifiers) != 2 {
		t.Fatalf("err = %v", err)
	}
	if f.calls != 2 {
		t.Fatalf("calls = %d, want 2 (initial load + one forced refresh)", f.calls)
	}

	// A newly created app is found via the forced refresh.
	ghost := uuid.New()
	f.mu.Lock()
	f.rows = append(f.rows, db.ListProjectAppsRow{ID: ghost, Slug: "ghost"})
	f.mu.Unlock()
	got, err := r.Resolve(context.Background(), pid, []string{"ghost"})
	if err != nil || got["ghost"] != ghost {
		t.Fatalf("got %v err %v", got, err)
	}
}
