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
	OrgPath           = OrgsPath + "/{slug}"
	JoinOrgPath       = OrgPath + "/join"
	JoinableOrgsPath  = server.APIPrefix + "/users/me/joinable-orgs"
)

// OrgService creates, reads, updates and deletes organizations and checks
// slugs; *orgs.Service satisfies it.
type OrgService interface {
	Create(ctx context.Context, owner uuid.UUID, name, slug string) (orgs.Org, error)
	Available(ctx context.Context, slug string) (bool, []string, error)
	List(ctx context.Context, user uuid.UUID) ([]orgs.Summary, error)
	Get(ctx context.Context, user uuid.UUID, slug string) (orgs.Detail, error)
	Update(ctx context.Context, user uuid.UUID, slug string, u orgs.Update) (orgs.Detail, error)
	Delete(ctx context.Context, user uuid.UUID, slug string) error
	Joinable(ctx context.Context, user uuid.UUID) ([]orgs.Joinable, error)
	Join(ctx context.Context, user uuid.UUID, slug string) (orgs.Org, bool, error)
}

// Org is an organization as seen by the signed-in user.
type Org struct {
	ID        string    `json:"id" format:"uuid"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	Role      string    `json:"role" enum:"owner,admin,member,viewer" doc:"The signed-in user's role in the organization."`
	CreatedAt time.Time `json:"created_at"`
}

// OrgSummary is an item of GET /api/v1/orgs.
type OrgSummary struct {
	Org
	ProjectCount int64 `json:"project_count" minimum:"0" doc:"Active projects in the organization."`
	MemberCount  int64 `json:"member_count" minimum:"1" doc:"Members of the organization."`
}

// OrgDetail is an organization with its settings.
type OrgDetail struct {
	Org
	AllowedDomains []string `json:"allowed_domains" doc:"Email domains (lower-case hostnames) whose users may join when domain_join is on."`
	DomainJoin     bool     `json:"domain_join" doc:"Whether users with a verified email at one of allowed_domains may join without an invitation."`
}

// ListOrgsInput is the request of GET /api/v1/orgs.
type ListOrgsInput struct{}

// ListOrgsOutput is the response of GET /api/v1/orgs.
type ListOrgsOutput struct {
	Body []OrgSummary
}

// OrgSlugInput names an organization in the path.
type OrgSlugInput struct {
	Slug string `path:"slug" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"The organization's slug."`
}

// OrgOutput is the response of GET and PATCH /api/v1/orgs/{slug}.
type OrgOutput struct {
	Body OrgDetail
}

// UpdateOrgInput is the request of PATCH /api/v1/orgs/{slug}. Omitted
// fields are left unchanged.
type UpdateOrgInput struct {
	OrgSlugInput
	Body struct {
		Name           *string   `json:"name,omitempty" minLength:"1" maxLength:"100" doc:"Display name; surrounding spaces are trimmed."`
		Slug           *string   `json:"slug,omitempty" pattern:"^[a-z0-9][a-z0-9-]{0,62}$" doc:"Must equal the current slug: slugs cannot be changed yet (slug_immutable)."`
		AllowedDomains *[]string `json:"allowed_domains,omitempty" maxItems:"50" doc:"Replaces the allowed email domains: lower-case hostnames, not public email providers (domain_not_allowed). Duplicates are dropped."`
		DomainJoin     *bool     `json:"domain_join,omitempty" doc:"Whether users with a verified email at an allowed domain may join without an invitation."`
	}
}

// JoinableOrg is an item of GET /api/v1/users/me/joinable-orgs.
type JoinableOrg struct {
	ID             string   `json:"id" format:"uuid"`
	Slug           string   `json:"slug"`
	Name           string   `json:"name"`
	MemberCount    int64    `json:"member_count" minimum:"0" doc:"Members of the organization."`
	ProjectCount   int64    `json:"project_count" minimum:"0" doc:"Active projects in the organization."`
	MemberInitials []string `json:"member_initials" maxItems:"3" doc:"Initials of up to three members, owners first."`
}

// ListJoinableOrgsInput is the request of GET /api/v1/users/me/joinable-orgs.
type ListJoinableOrgsInput struct{}

// ListJoinableOrgsOutput is the response of GET
// /api/v1/users/me/joinable-orgs.
type ListJoinableOrgsOutput struct {
	Body []JoinableOrg
}

// JoinOrgOutput is the response of POST /api/v1/orgs/{slug}/join.
type JoinOrgOutput struct {
	Body Org
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

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-orgs",
		Method:      http.MethodGet,
		Path:        OrgsPath,
		Summary:     "List my organizations",
		Description: "Lists the active organizations the signed-in user is a member of, with their role and the number of projects and members of each, ordered by name.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeInternal), o.list)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-org",
		Method:      http.MethodGet,
		Path:        OrgPath,
		Summary:     "Get an organization",
		Description: "Returns the organization and the signed-in user's role in it. Answers `forbidden` (403) when it does not exist or the user is not a member, so the two cannot be told apart.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), o.get)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "update-org",
		Method:      http.MethodPatch,
		Path:        OrgPath,
		Summary:     "Update an organization",
		Description: "Changes the name, allowed email domains or domain join of the organization. Owners and admins only (403 `forbidden` otherwise, and for an organization the user is not a member of). " +
			"A public email domain answers `domain_not_allowed`; a slug other than the current one answers `slug_immutable`. Audited as `org.updated`.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeDomainNotAllowed, identity.CodeUnauthenticated, identity.CodeForbidden,
		identity.CodeSlugImmutable, identity.CodeInternal), o.update)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "delete-org",
		Method:        http.MethodDelete,
		Path:          OrgPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Delete an organization",
		Description:   "Soft-deletes the organization; its members lose access to it and its projects, and its slug becomes free. Owners only (403 `forbidden` otherwise, and for an organization the user is not a member of). Audited as `org.deleted`.",
		Tags:          []string{server.TagOrganizations},
		Security:      security,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), o.delete)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-joinable-orgs",
		Method:      http.MethodGet,
		Path:        JoinableOrgsPath,
		Summary:     "List organizations I can join",
		Description: "Lists the active organizations the signed-in user is not a member of that have domain join on and list the domain of the user's verified email among their allowed domains, ordered by name. " +
			"An unverified email or one at a public email provider (gmail.com, outlook.com…) matches none.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeUnauthenticated, identity.CodeSessionExpired, identity.CodeInternal), o.joinable)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "join-org",
		Method:      http.MethodPost,
		Path:        JoinOrgPath,
		Summary:     "Join an organization by verified email domain",
		Description: "Makes the signed-in user a `member` of the organization when it has domain join on and lists the domain of the user's verified email among its allowed domains, and returns the organization with the user's role. " +
			"Answers `forbidden` (403) otherwise, and for an organization that does not exist. Idempotent: a user who already belongs to it gets it back with their current role and nothing changes. Audited as `member.joined`.",
		Tags:     []string{server.TagOrganizations},
		Security: security,
	}, identity.CodeUnauthenticated, identity.CodeSessionExpired, identity.CodeForbidden, identity.CodeInternal), o.join)
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
	return &CreateOrgOutput{Body: toOrg(org)}, nil
}

func toOrg(org orgs.Org) Org {
	return Org{
		ID:        org.ID.String(),
		Slug:      org.Slug,
		Name:      org.Name,
		Role:      org.Role,
		CreatedAt: org.CreatedAt.UTC(),
	}
}

func toDetail(d orgs.Detail) OrgDetail {
	domains := d.AllowedDomains
	if domains == nil {
		domains = []string{}
	}
	return OrgDetail{Org: toOrg(d.Org), AllowedDomains: domains, DomainJoin: d.DomainJoin}
}

// signedInUser returns the signed-in user, or the unauthenticated problem.
func signedInUser(ctx context.Context) (uuid.UUID, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	return p.UserID, nil
}

// orgProblem maps a read/update/delete error of orgs.Service to a problem.
func (o *Orgs) orgProblem(ctx context.Context, op string, err error) error {
	var notAllowed *orgs.DomainNotAllowedError
	switch {
	case errors.Is(err, orgs.ErrNotFound), errors.Is(err, orgs.ErrForbidden):
		return identity.Err(identity.CodeForbidden)
	case errors.Is(err, orgs.ErrSlugImmutable):
		return identity.Err(identity.CodeSlugImmutable)
	case errors.As(err, &notAllowed):
		return identity.Err(identity.CodeDomainNotAllowed)
	case errors.Is(err, orgs.ErrInvalid):
		return identity.Err(identity.CodeInvalidRequest)
	case errors.Is(err, orgs.ErrUserGone):
		return identity.Err(identity.CodeSessionExpired)
	default:
		o.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (o *Orgs) list(ctx context.Context, _ *ListOrgsInput) (*ListOrgsOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	list, err := o.svc.List(ctx, uid)
	if err != nil {
		return nil, o.orgProblem(ctx, "list organizations", err)
	}
	out := &ListOrgsOutput{Body: make([]OrgSummary, 0, len(list))}
	for _, s := range list {
		out.Body = append(out.Body, OrgSummary{Org: toOrg(s.Org), ProjectCount: s.ProjectCount, MemberCount: s.MemberCount})
	}
	return out, nil
}

func (o *Orgs) get(ctx context.Context, in *OrgSlugInput) (*OrgOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	d, err := o.svc.Get(ctx, uid, in.Slug)
	if err != nil {
		return nil, o.orgProblem(ctx, "get organization", err)
	}
	return &OrgOutput{Body: toDetail(d)}, nil
}

func (o *Orgs) update(ctx context.Context, in *UpdateOrgInput) (*OrgOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	d, err := o.svc.Update(ctx, uid, in.Slug, orgs.Update{
		Name:           in.Body.Name,
		Slug:           in.Body.Slug,
		AllowedDomains: in.Body.AllowedDomains,
		DomainJoin:     in.Body.DomainJoin,
	})
	if err != nil {
		return nil, o.orgProblem(ctx, "update organization", err)
	}
	return &OrgOutput{Body: toDetail(d)}, nil
}

func (o *Orgs) delete(ctx context.Context, in *OrgSlugInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := o.svc.Delete(ctx, uid, in.Slug); err != nil {
		return nil, o.orgProblem(ctx, "delete organization", err)
	}
	return nil, nil
}

func (o *Orgs) joinable(ctx context.Context, _ *ListJoinableOrgsInput) (*ListJoinableOrgsOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	list, err := o.svc.Joinable(ctx, uid)
	if err != nil {
		return nil, o.orgProblem(ctx, "list joinable organizations", err)
	}
	out := &ListJoinableOrgsOutput{Body: make([]JoinableOrg, 0, len(list))}
	for _, j := range list {
		initials := j.MemberInitials
		if initials == nil {
			initials = []string{}
		}
		out.Body = append(out.Body, JoinableOrg{
			ID: j.ID.String(), Slug: j.Slug, Name: j.Name,
			MemberCount: j.MemberCount, ProjectCount: j.ProjectCount, MemberInitials: initials,
		})
	}
	return out, nil
}

func (o *Orgs) join(ctx context.Context, in *OrgSlugInput) (*JoinOrgOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	org, _, err := o.svc.Join(ctx, uid, in.Slug)
	if err != nil {
		return nil, o.orgProblem(ctx, "join organization", err)
	}
	return &JoinOrgOutput{Body: toOrg(org)}, nil
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
