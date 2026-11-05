package privacy

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

type fakeStore struct {
	mu    sync.Mutex
	rows  []db.ListProjectPrivacyPoliciesRow
	err   error
	calls int
}

func (s *fakeStore) ListProjectPrivacyPolicies(context.Context, uuid.UUID) ([]db.ListProjectPrivacyPoliciesRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	return s.rows, s.err
}

func (s *fakeStore) set(rows []db.ListProjectPrivacyPoliciesRow, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows, s.err = rows, err
}

func TestResolverPolicyChangeWithinTTL(t *testing.T) {
	ctx := context.Background()
	project, app, other := uuid.New(), uuid.New(), uuid.New()
	store := &fakeStore{}
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	r := NewResolver(store, time.Minute)
	r.now = func() time.Time { return now }

	masked := func(appID uuid.UUID, path string) bool {
		t.Helper()
		red, err := r.Redactor(ctx, project, appID)
		if err != nil {
			t.Fatal(err)
		}
		return red.RawPath(path) != path
	}

	// No policy: only the defaults.
	if masked(app, "/a?email=x") || !masked(app, "/a?token=x") {
		t.Fatal("defaults")
	}

	// A new project policy and an app policy are saved...
	store.set([]db.ListProjectPrivacyPoliciesRow{
		{MaskQueryParams: []string{"^email$"}},
		{AppID: &app, MaskQueryParams: []string{"^phone$"}},
	}, nil)
	// ...still cached just before the TTL ends...
	now = now.Add(time.Minute - time.Second)
	if masked(app, "/a?email=x") {
		t.Fatal("policy applied before the cache expired")
	}
	// ...and applied once it has.
	now = now.Add(time.Second)
	if !masked(app, "/a?email=x") || !masked(app, "/a?phone=1") || !masked(app, "/a?token=x") {
		t.Fatal("app redactor misses project, app or default patterns")
	}
	if !masked(other, "/a?email=x") || masked(other, "/a?phone=1") {
		t.Fatal("other app: want project policy only")
	}
	if store.calls != 2 {
		t.Fatalf("store calls = %d, want 2 (one per TTL)", store.calls)
	}

	// A failing reload keeps the last good policy.
	store.set(nil, errors.New("down"))
	now = now.Add(2 * time.Minute)
	if !masked(app, "/a?phone=1") {
		t.Fatal("stale policy dropped on reload failure")
	}

	// With nothing cached the error surfaces.
	if _, err := r.Redactor(ctx, uuid.New(), app); err == nil {
		t.Fatal("want error with an empty cache")
	}
}
