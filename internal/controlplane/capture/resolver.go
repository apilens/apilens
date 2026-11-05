package capture

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/singleflight"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// PolicyGetter is the store subset the resolver needs; *db.Queries
// satisfies it.
type PolicyGetter interface {
	GetCapturePolicy(ctx context.Context, appID uuid.UUID) (db.GetCapturePolicyRow, error)
}

type cachedPolicy struct {
	policy   Policy
	loadedAt time.Time
}

// Resolver serves each app's capture policy (the heartbeat response) from an
// in-process cache refreshed every ttl (ingest.app_cache_ttl), so a change
// reaches every edge within one TTL without a Postgres read per heartbeat.
type Resolver struct {
	store PolicyGetter
	ttl   time.Duration
	now   func() time.Time

	mu    sync.RWMutex
	cache map[uuid.UUID]cachedPolicy
	group singleflight.Group
}

// NewResolver builds a resolver.
func NewResolver(store PolicyGetter, ttl time.Duration) *Resolver {
	return &Resolver{store: store, ttl: ttl, now: time.Now, cache: map[uuid.UUID]cachedPolicy{}}
}

// Policy returns the capture policy of app: its stored row, or Default when
// it has none. When reloading an expired entry fails the previous one is
// kept; with nothing cached the error is returned.
func (r *Resolver) Policy(ctx context.Context, appID uuid.UUID) (Policy, error) {
	r.mu.RLock()
	cached, ok := r.cache[appID]
	r.mu.RUnlock()
	if ok && r.now().Sub(cached.loadedAt) < r.ttl {
		return cached.policy, nil
	}
	v, err, _ := r.group.Do(appID.String(), func() (any, error) {
		return r.load(ctx, appID)
	})
	if err != nil {
		if ok {
			return cached.policy, nil
		}
		return Policy{}, err
	}
	return v.(Policy), nil
}

func (r *Resolver) load(ctx context.Context, appID uuid.UUID) (Policy, error) {
	row, err := r.store.GetCapturePolicy(ctx, appID)
	var p Policy
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		p = Default()
	case err != nil:
		return Policy{}, fmt.Errorf("capture: get policy: %w", err)
	default:
		p = fromRow(row.Enabled, row.SampleRate, row.CaptureHeaders, row.CaptureRequestBody, row.CaptureResponseBody, row.MaxPayloadBytes)
	}
	r.mu.Lock()
	r.cache[appID] = cachedPolicy{policy: p, loadedAt: r.now()}
	r.mu.Unlock()
	return p, nil
}
