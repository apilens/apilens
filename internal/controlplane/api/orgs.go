package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the organization endpoints.
const (
	OrgsPath          = server.APIPrefix + "/orgs"
	SlugAvailablePath = OrgsPath + "/slug-available"
)

// OrgService creates organizations and checks slugs; *orgs.Service
// satisfies it.
type OrgService interface {
	Create(ctx context.Context, owner uuid.UUID, name, slug string) (orgs.Org, error)
	Available(ctx context.Context, slug string) (bool, []string, error)
}

// Org is an organization as seen by the signed-in user.
type Org struct {
	ID        string    `json:"id" format:"uuid"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	Role      string    `json:"role" enum:"owner,admin,member,viewer" doc:"The signed-in user's role in the organization."`
	CreatedAt time.Time `json:"created_at"`
}

// CreateOrgInput is the request of POST /api/v1/orgs.
type CreateOrgInput struct {
	Body struct {
		Name string `json:"name" minLength:"1" maxLength:"100" doc:"Display name; surrounding spaces are trimmed."`
		Slug string `json:"slug" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"URL name, globally unique among organizations: lower-case letters, digits and hyphens, starting with a letter or digit, at most 63 characters."`
	}
}

// CreateOrgOutput is the response of POST /api/v1/orgs.
type CreateOrgOutput struct {
	Body Org
}

// SlugAvailableInput is the request of GET /api/v1/orgs/slug-available.
type SlugAvailableInput struct {
	Slug string `query:"slug" required:"true" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"The slug to check."`
}

// SlugAvailableOutput is the response of GET /api/v1/orgs/slug-available.
type SlugAvailableOutput struct {
	Body struct {
		Available   bool     `json:"available" doc:"Whether a new organization can use the slug."`
		Suggestions []string `json:"suggestions" maxItems:"3" doc:"Up to three free alternatives when the slug is not available; empty otherwise."`
	}
}

// Orgs serves the organization endpoints.
type Orgs struct {
	svc       OrgService
	limiter   *ratelimit.Limiter
	slugCheck ratelimit.Rate
	logger    *slog.Logger
}

// NewOrgs returns the organization endpoints over svc. limiter enforces
// slugCheck per user on the slug availability check.
func NewOrgs(svc OrgService, limiter *ratelimit.Limiter, slugCheck ratelimit.Rate, logger *slog.Logger) *Orgs {
	return &Orgs{svc: svc, limiter: limiter, slugCheck: slugCheck, logger: logger}
}

// Register mounts the organization operations. They declare the session
// scheme, so authn.Middleware must be installed on api before.
func (o *Orgs) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "create-org",
		Method:        http.MethodPost,
		Path:          OrgsPath,
		DefaultStatus: http.StatusCreated,
		Summary:       "Create an organization",
		Description:   "Creates an organization owned by the signed-in user. Answers `slug_taken` (409) with up to three free `suggestions` when the slug is reserved or used by another organization. Audited as `org.created`.",
		Tags:          []string{server.TagOrganizations},
		Security:      security,
	}, identity.CodeInvalidRequest, identity.CodeSlugTaken, identity.CodeUnauthenticated, identity.CodeSessionExpired, identity.CodeInternal), o.create)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "check-org-slug",
		Method:      http.MethodGet,
		Path:        SlugAvailablePath,
		Summary:     "Check whether an organization slug is free",
		Description: "Answers whether a new organization can use `slug` and, when it cannot (taken or reserved), up to three free alternatives. Rate-limited per user.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
		Middlewares: huma.Middlewares{o.limiter.Limit(api, "org_slug_check", ratelimit.Rate{}, ratelimit.Key{Rate: o.slugCheck, From: userKey})},
	}, identity.CodeUnauthenticated, identity.CodeRateLimited, identity.CodeInternal), o.slugAvailable)
}

// userKey keys a per-user rate limit by the signed-in user.
func userKey(ctx huma.Context) string {
	p, ok := authn.FromContext(ctx.Context())
	if !ok || p.Kind != authn.KindUser {
		return ""
	}
	return p.UserID.String()
}

func (o *Orgs) create(ctx context.Context, in *CreateOrgInput) (*CreateOrgOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	org, err := o.svc.Create(ctx, p.UserID, in.Body.Name, in.Body.Slug)
	var taken *orgs.SlugTakenError
	switch {
	case errors.As(err, &taken):
		return nil, identity.ErrSlugTaken(taken.Suggestions)
	case errors.Is(err, orgs.ErrInvalid):
		return nil, identity.Err(identity.CodeInvalidRequest)
	case errors.Is(err, orgs.ErrUserGone):
		return nil, identity.Err(identity.CodeSessionExpired)
	case err != nil:
		o.logger.ErrorContext(ctx, "create organization", "error", err)
		return nil, identity.Err(identity.CodeInternal)
	}
	return &CreateOrgOutput{Body: Org{
		ID:        org.ID.String(),
		Slug:      org.Slug,
		Name:      org.Name,
		Role:      org.Role,
		CreatedAt: org.CreatedAt.UTC(),
	}}, nil
}

func (o *Orgs) slugAvailable(ctx context.Context, in *SlugAvailableInput) (*SlugAvailableOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	available, suggestions, err := o.svc.Available(ctx, in.Slug)
	if err != nil {
		o.logger.ErrorContext(ctx, "check organization slug", "error", err)
		return nil, identity.Err(identity.CodeInternal)
	}
	out := &SlugAvailableOutput{}
	out.Body.Available = available
	out.Body.Suggestions = suggestions
	if out.Body.Suggestions == nil {
		out.Body.Suggestions = []string{}
	}
	return out, nil
}
