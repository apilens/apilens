// Package api is the control-plane API role: organizations, projects, apps,
// members and keys. It mounts its operations on the typed API.
package api

import (
	"log/slog"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// Deps are what the control-plane operations run on. Zero values are enough
// when only the OpenAPI document is read.
type Deps struct {
	Orgs     OrgService
	Members  MemberService
	Projects ProjectService
	Context  ContextService
	Limiter  *ratelimit.Limiter
	Limits   config.RateLimitsConfig
	Logger   *slog.Logger
}

// Register mounts the control-plane operations on api. They declare the
// session scheme, so authn.Middleware must be installed on api before.
func Register(api huma.API, d Deps) {
	NewOrgs(d.Orgs, d.Limiter, ratelimit.Rate(d.Limits.SlugCheckPerUser), d.Logger).Register(api)
	NewMembers(d.Members, d.Logger).Register(api)
	NewProjects(d.Projects, d.Limiter, ratelimit.Rate(d.Limits.SlugCheckPerUser), d.Logger).Register(api)
	NewContext(d.Context, d.Logger).Register(api)
}
