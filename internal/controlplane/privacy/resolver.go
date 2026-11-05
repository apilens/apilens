package privacy

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// PolicyLister is the store subset the resolver needs.
type PolicyLister interface {
	ListProjectPrivacyPolicies(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectPrivacyPoliciesRow, error)
}

type projectRedactors struct {
	project  *Redactor               // defaults + the project policy
	apps     map[uuid.UUID]*Redactor // defaults + project + app policy
	loadedAt time.Time
}

// Resolver serves the compiled policy of each project and app from an
// in-process cache refreshed every ttl (ingest.app_cache_ttl), so a policy
// change reaches every edge within one TTL and the ingest path never waits
// on Postgres for a cached project.
type Resolver struct {
	store PolicyLister
	ttl   time.Duration
	now   func() time.Time

	mu    sync.RWMutex
	cache map[uuid.UUID]*projectRedactors
	group singleflight.Group
}

// NewResolver builds a resolver.
func NewResolver(store PolicyLister, ttl time.Duration) *Resolver {
	return &Resolver{store: store, ttl: ttl, now: time.Now, cache: map[uuid.UUID]*projectRedactors{}}
}

// Redactor returns the redactor for records of app in project: the defaults
// plus the project's and the app's policies. When reloading an expired entry
// fails the previous one is kept (it is never weaker than the defaults); with
// nothing cached the error is returned.
func (r *Resolver) Redactor(ctx context.Context, projectID, appID uuid.UUID) (*Redactor, error) {
	p, err := r.get(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if red, ok := p.apps[appID]; ok {
		return red, nil
	}
	return p.project, nil
}

func (r *Resolver) get(ctx context.Context, projectID uuid.UUID) (*projectRedactors, error) {
	r.mu.RLock()
	cached, ok := r.cache[projectID]
	r.mu.RUnlock()
	if ok && r.now().Sub(cached.loadedAt) < r.ttl {
		return cached, nil
	}
	v, err, _ := r.group.Do(projectID.String(), func() (any, error) {
		return r.load(ctx, projectID)
	})
	if err != nil {
		if ok {
			return cached, nil
		}
		return nil, err
	}
	return v.(*projectRedactors), nil
}

func (r *Resolver) load(ctx context.Context, projectID uuid.UUID) (*projectRedactors, error) {
	rows, err := r.store.ListProjectPrivacyPolicies(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("privacy: list policies: %w", err)
	}
	var project Policy
	apps := map[uuid.UUID]Policy{}
	for _, row := range rows {
		pol := Policy{QueryParams: row.MaskQueryParams, Headers: row.MaskHeaders, BodyFields: row.MaskBodyFields}
		if row.AppID == nil {
			project = pol
		} else {
			apps[*row.AppID] = pol
		}
	}
	out := &projectRedactors{apps: make(map[uuid.UUID]*Redactor, len(apps)), loadedAt: r.now()}
	if out.project, err = Compile(project); err != nil {
		return nil, fmt.Errorf("privacy: compile project policy: %w", err)
	}
	for id, pol := range apps {
		if out.apps[id], err = Compile(project, pol); err != nil {
			return nil, fmt.Errorf("privacy: compile app %s policy: %w", id, err)
		}
	}
	r.mu.Lock()
	r.cache[projectID] = out
	r.mu.Unlock()
	return out, nil
}
