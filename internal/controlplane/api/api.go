// Package api is the control-plane API role: organizations, projects, apps,
// members and keys. It mounts its operations on the typed API.
package api

import (
	"log/slog"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// Deps are what the control-plane operations run on. Zero values are enough
// when only the OpenAPI document is read.
type Deps struct {
	Orgs     OrgService
	Members  MemberService
	Projects ProjectService
	APIKeys  APIKeyService
	Privacy  PrivacyService
	Capture  CaptureService
	Context  ContextService
	// Apps manages a project's apps; AppRejections (nil without Valkey)
	// reads the records ingest refused because of their app.
	Apps          AppService
	AppRejections AppRejectionReader
	// Guard authorizes every operation on an organization (authz.Require);
	// nil refuses them with authz_unavailable (fail closed).
	Guard   *authz.Guard
	Limiter *ratelimit.Limiter
	Limits  config.RateLimitsConfig
	Logger  *slog.Logger
	// SensitiveActionMaxAge is identity.sensitive_action_max_age: how old a
	// sign-in may be for sensitive operations (authz.RequireRecentAuth).
	// Zero means authz.DefaultRecentAuth.
	SensitiveActionMaxAge time.Duration

	// Invitations may be nil when only the OpenAPI document is read.
	Invitations InvitationService

	// SSO manages organizations' SSO connections; Issuer is the identity
	// issuer URL their redirect and start URLs are under.
	SSO    SSOService
	Issuer string
}

// Register mounts the control-plane operations on api. They declare the
// session scheme, so authn.Middleware must be installed on api before.
func Register(api huma.API, d Deps) {
	NewOrgs(d.Orgs, d.Guard, d.Limiter, ratelimit.Rate(d.Limits.SlugCheckPerUser), d.Logger).Register(api)
	NewMembers(d.Members, d.Guard, d.Logger).Register(api)
	NewProjects(d.Projects, d.Limiter, ratelimit.Rate(d.Limits.SlugCheckPerUser), d.Logger).WithRecentAuth(d.SensitiveActionMaxAge).Register(api)
	NewAPIKeys(d.APIKeys, d.Logger).WithRecentAuth(d.SensitiveActionMaxAge).Register(api)
	NewPrivacy(d.Privacy, d.Logger).Register(api)
	NewCapturePolicies(d.Capture, d.Guard, d.Logger).Register(api)
	var guard ProjectAuthorizer
	if d.Guard != nil {
		guard = d.Guard
	}
	NewApps(d.Apps, d.AppRejections, guard, d.Logger).Register(api)
	NewContext(d.Context, d.Logger).Register(api)
	NewInvitations(d.Invitations, d.Logger).Register(api)
	NewSSOConnections(d.SSO, d.Guard, d.Issuer, d.Logger).Register(api)
}
