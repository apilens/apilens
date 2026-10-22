// Package catalog resolves the identifiers SDKs send (app UUID or slug) to
// app IDs within a project, with a small per-project cache.
package catalog

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// AppLister is the store subset the resolver needs.
type AppLister interface {
	ListProjectApps(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectAppsRow, error)
}

// UnknownAppsError lists identifiers that matched no app in the project.
type UnknownAppsError struct{ Identifiers []string }

func (e *UnknownAppsError) Error() string {
	return "unknown app_id(s): " + strings.Join(e.Identifiers, ", ")
}

type projectApps struct {
	bySlug   map[string]uuid.UUID
	ids      map[uuid.UUID]bool
	loadedAt time.Time
}

// AppResolver caches each project's apps for ttl. Unknown identifiers force
// one refresh (rate-limited by minRefresh) so newly created apps are picked
// up without waiting for the TTL.
type AppResolver struct {
	store      AppLister
	ttl        time.Duration
	minRefresh time.Duration

	mu    sync.RWMutex
	cache map[uuid.UUID]*projectApps
	group singleflight.Group
}

// NewAppResolver builds a resolver.
func NewAppResolver(store AppLister, ttl time.Duration) *AppResolver {
	return &AppResolver{store: store, ttl: ttl, minRefresh: 2 * time.Second, cache: map[uuid.UUID]*projectApps{}}
}

// Resolve maps every identifier to an app ID. Empty identifiers are rejected
// by the caller; this function only reports identifiers it cannot match.
func (r *AppResolver) Resolve(ctx context.Context, projectID uuid.UUID, identifiers []string) (map[string]uuid.UUID, error) {
	apps, err := r.get(ctx, projectID, false)
	if err != nil {
		return nil, err
	}
	out, missing := match(apps, identifiers)
	if len(missing) > 0 && time.Since(apps.loadedAt) >= r.minRefresh {
		if apps, err = r.get(ctx, projectID, true); err != nil {
			return nil, err
		}
		out, missing = match(apps, identifiers)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, &UnknownAppsError{Identifiers: missing}
	}
	return out, nil
}

func match(apps *projectApps, identifiers []string) (map[string]uuid.UUID, []string) {
	out := make(map[string]uuid.UUID, len(identifiers))
	var missing []string
	for _, ident := range identifiers {
		if _, done := out[ident]; done {
			continue
		}
		if id, err := uuid.Parse(ident); err == nil && apps.ids[id] {
			out[ident] = id
			continue
		}
		if id, ok := apps.bySlug[ident]; ok {
			out[ident] = id
			continue
		}
		missing = append(missing, ident)
	}
	return out, missing
}

func (r *AppResolver) get(ctx context.Context, projectID uuid.UUID, force bool) (*projectApps, error) {
	if !force {
		r.mu.RLock()
		apps, ok := r.cache[projectID]
		r.mu.RUnlock()
		if ok && time.Since(apps.loadedAt) < r.ttl {
			return apps, nil
		}
	}
	v, err, _ := r.group.Do(projectID.String(), func() (any, error) {
		rows, err := r.store.ListProjectApps(ctx, projectID)
		if err != nil {
			return nil, fmt.Errorf("catalog: list apps: %w", err)
		}
		apps := &projectApps{bySlug: make(map[string]uuid.UUID, len(rows)), ids: make(map[uuid.UUID]bool, len(rows)), loadedAt: time.Now()}
		for _, row := range rows {
			apps.bySlug[row.Slug] = row.ID
			apps.ids[row.ID] = true
		}
		r.mu.Lock()
		r.cache[projectID] = apps
		r.mu.Unlock()
		return apps, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*projectApps), nil
}
