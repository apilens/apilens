package capture

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

func intp(v int) *int { return &v }

func TestValidate(t *testing.T) {
	ok := []Policy{
		Default(),
		{SampleRate: 0},
		{Enabled: true, SampleRate: 0.1234, MaxPayloadBytes: intp(1)},
		{Enabled: true, SampleRate: 0.5, MaxPayloadBytes: intp(MaxPayloadBytesLimit)},
	}
	for _, p := range ok {
		if err := p.Validate(); err != nil {
			t.Errorf("Validate(%+v) = %v", p, err)
		}
	}
	bad := []struct {
		field string
		p     Policy
	}{
		{"sample_rate", Policy{SampleRate: -0.1}},
		{"sample_rate", Policy{SampleRate: 1.01}},
		{"sample_rate", Policy{SampleRate: math.NaN()}},
		{"sample_rate", Policy{SampleRate: 0.12345}},
		{"max_payload_bytes", Policy{SampleRate: 1, MaxPayloadBytes: intp(0)}},
		{"max_payload_bytes", Policy{SampleRate: 1, MaxPayloadBytes: intp(MaxPayloadBytesLimit + 1)}},
	}
	for _, c := range bad {
		err := c.p.Validate()
		var inv *InvalidError
		if !errors.As(err, &inv) || inv.Field != c.field || !errors.Is(err, ErrInvalid) {
			t.Errorf("Validate(%+v) = %v, want %s error", c.p, err, c.field)
		}
	}
}

type fakeStore struct {
	mu    sync.Mutex
	row   *db.GetCapturePolicyRow
	err   error
	calls int
}

func (s *fakeStore) GetCapturePolicy(context.Context, uuid.UUID) (db.GetCapturePolicyRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.err != nil {
		return db.GetCapturePolicyRow{}, s.err
	}
	if s.row == nil {
		return db.GetCapturePolicyRow{}, pgx.ErrNoRows
	}
	return *s.row, nil
}

func (s *fakeStore) set(row *db.GetCapturePolicyRow, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.row, s.err = row, err
}

// A saved policy is served on heartbeat within one cache TTL.
func TestResolverPolicyChangeWithinTTL(t *testing.T) {
	ctx := context.Background()
	app := uuid.New()
	store := &fakeStore{}
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	r := NewResolver(store, time.Minute)
	r.now = func() time.Time { return now }

	get := func() Policy {
		t.Helper()
		p, err := r.Policy(ctx, app)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}

	// No row: capture everything.
	if p := get(); p != Default() {
		t.Fatalf("row-less policy = %+v", p)
	}

	limit := int32(4096)
	store.set(&db.GetCapturePolicyRow{AppID: app, Enabled: true, SampleRate: 0.25, CaptureHeaders: true, MaxPayloadBytes: &limit}, nil)
	now = now.Add(time.Minute - time.Second)
	if p := get(); p != Default() {
		t.Fatal("policy served before the cache expired")
	}
	now = now.Add(time.Second)
	p := get()
	if !p.Enabled || p.SampleRate != 0.25 || !p.CaptureHeaders || p.CaptureRequestBody || p.CaptureResponseBody ||
		p.MaxPayloadBytes == nil || *p.MaxPayloadBytes != 4096 {
		t.Fatalf("policy after TTL = %+v", p)
	}
	if store.calls != 2 {
		t.Fatalf("store calls = %d, want 2", store.calls)
	}

	// A failed reload keeps the cached policy.
	store.set(nil, errors.New("db down"))
	now = now.Add(time.Minute)
	if got := get(); got.SampleRate != 0.25 {
		t.Fatalf("stale policy = %+v", got)
	}
}

func TestResolverErrorWithoutCache(t *testing.T) {
	store := &fakeStore{err: errors.New("db down")}
	if _, err := NewResolver(store, time.Minute).Policy(context.Background(), uuid.New()); err == nil {
		t.Fatal("want error with nothing cached")
	}
}
