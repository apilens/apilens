package query

import (
	"context"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// discoveredRoutesStore lists the route templates the SDKs reported in their
// metadata (POST /v1/metadata). A Catalog without it lists only endpoints
// with traffic.
type discoveredRoutesStore interface {
	ListProjectDiscoveredRoutes(ctx context.Context, arg db.ListProjectDiscoveredRoutesParams) ([]db.ListProjectDiscoveredRoutesRow, error)
}

// discoveredRoutes loads the declared routes of project in env (empty: all
// environments).
func (s *Service) discoveredRoutes(ctx context.Context, project uuid.UUID, env string) ([]db.ListProjectDiscoveredRoutesRow, error) {
	store, ok := s.catalog.(discoveredRoutesStore)
	if !ok {
		return nil, nil
	}
	rows, err := store.ListProjectDiscoveredRoutes(ctx, db.ListProjectDiscoveredRoutesParams{ProjectID: project, Environment: env})
	if err != nil {
		return nil, internalError("discovered routes", err)
	}
	return rows, nil
}

// withDiscovered appends to eps, the endpoints with traffic, the declared
// routes without any as zero rows marked discovered_only, until eps holds
// limit endpoints. Routes excluded from metrics on their app are left out.
// Endpoints are keyed on method and path, like the traffic rows, so a route
// declared by several apps is listed once.
func withDiscovered(eps []endpoint, routes []db.ListProjectDiscoveredRoutesRow, rules metricRules, limit int) []endpoint {
	seen := make(map[string]bool, len(eps)+len(routes))
	for _, e := range eps {
		seen[e.Method+" "+e.Path] = true
	}
	for _, r := range routes {
		if len(eps) >= limit {
			break
		}
		k := r.Method + " " + r.Path
		if seen[k] || rules.excludes(endpointKey{app: r.AppID, method: r.Method, path: r.Path}) {
			continue
		}
		seen[k] = true
		eps = append(eps, endpoint{Method: r.Method, Path: r.Path, DiscoveredOnly: true})
	}
	return eps
}

// excludes reports whether k is excluded from metrics.
func (r metricRules) excludes(k endpointKey) bool {
	for _, e := range r.excluded {
		if e == k {
			return true
		}
	}
	return false
}
