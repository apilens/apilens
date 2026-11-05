package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// PrivacyPolicyPath is the project privacy policy endpoint.
const PrivacyPolicyPath = ProjectPath + "/privacy-policy"

// PrivacyService reads and replaces privacy policies; *privacy.Service
// satisfies it.
type PrivacyService interface {
	Get(ctx context.Context, user uuid.UUID, slug, app string) (privacy.Scoped, error)
	Put(ctx context.Context, user uuid.UUID, slug, app string, pol privacy.Policy) (privacy.Scoped, error)
}

// PrivacyDefaults are the built-in patterns the edge always applies.
type PrivacyDefaults struct {
	MaskQueryParams  []string `json:"mask_query_params" doc:"Built-in query parameter name patterns."`
	MaskHeaders      []string `json:"mask_headers" doc:"Built-in header name patterns."`
	SensitiveHeaders []string `json:"sensitive_headers" doc:"Header names (lower case, matched exactly) whose values are always masked."`
	MaskBodyFields   []string `json:"mask_body_fields" doc:"Built-in JSON body field name patterns."`
}

// PrivacyPolicy is the server-side deny list of a project or one of its apps.
type PrivacyPolicy struct {
	App             *string         `json:"app" required:"true" nullable:"true" doc:"The slug of the app the policy is scoped to; null for the project-wide policy."`
	MaskQueryParams []string        `json:"mask_query_params" doc:"Case-insensitive RE2 patterns matched against query parameter names in raw_path."`
	MaskHeaders     []string        `json:"mask_headers" doc:"Case-insensitive RE2 patterns matched against captured request and response header names."`
	MaskBodyFields  []string        `json:"mask_body_fields" doc:"Case-insensitive RE2 patterns matched against JSON body field names, at any depth."`
	Defaults        PrivacyDefaults `json:"defaults" doc:"The built-in patterns, applied on top of this policy whatever it says."`
	UpdatedAt       *time.Time      `json:"updated_at" required:"true" nullable:"true" doc:"When the policy was last saved; null if it never was (only the defaults apply)."`
}

// PrivacyPolicyOutput is the response of the privacy policy operations.
type PrivacyPolicyOutput struct {
	Body PrivacyPolicy
}

// PrivacyScopeInput names the project and, optionally, one of its apps.
type PrivacyScopeInput struct {
	ProjectSlugInput
	App string `query:"app" maxLength:"64" doc:"An app's slug or id to address its own policy, applied on top of the project's; omit for the project-wide policy."`
}

// PutPrivacyPolicyInput is the request of PUT
// /api/v1/projects/{slug}/privacy-policy.
type PutPrivacyPolicyInput struct {
	PrivacyScopeInput
	Body struct {
		MaskQueryParams []string `json:"mask_query_params,omitempty" maxItems:"50" doc:"Query parameter name patterns (case-insensitive RE2, at most 256 bytes each); omitted means none."`
		MaskHeaders     []string `json:"mask_headers,omitempty" maxItems:"50" doc:"Header name patterns (case-insensitive RE2, at most 256 bytes each); omitted means none."`
		MaskBodyFields  []string `json:"mask_body_fields,omitempty" maxItems:"50" doc:"JSON body field name patterns (case-insensitive RE2, at most 256 bytes each); omitted means none."`
	}
}

// Privacy serves the privacy policy endpoints.
type Privacy struct {
	svc    PrivacyService
	logger *slog.Logger
}

// NewPrivacy returns the privacy policy endpoints over svc.
func NewPrivacy(svc PrivacyService, logger *slog.Logger) *Privacy {
	return &Privacy{svc: svc, logger: logger}
}

// Register mounts the privacy policy operations. They declare the session
// scheme, so authn.Middleware must be installed on api before.
func (p *Privacy) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	tags := []string{server.TagProjects}
	notMember := "Answers `forbidden` (403) when the project does not exist or the user is not a member of its organization, so the cases cannot be told apart."
	how := "The ingest edge masks, before storing a record, the values of matching query parameters in `raw_path`, captured headers, JSON body fields (string and number values) and `key=value` pairs in log messages, " +
		"using the built-in defaults plus the project's policy plus the record's app's policy. Patterns only add to the defaults. Edges pick a change up within the app cache TTL (`ingest.app_cache_ttl`, 60 s by default)."

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-privacy-policy",
		Method:      http.MethodGet,
		Path:        PrivacyPolicyPath,
		Summary:     "Get a privacy policy",
		Description: "Returns the server-side privacy policy of the project, or of one of its apps with `?app=`, and the built-in defaults. " + how +
			" An unknown app answers `invalid_request`. " + notMember,
		Tags:     tags,
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), p.get)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "put-privacy-policy",
		Method:      http.MethodPut,
		Path:        PrivacyPolicyPath,
		Summary:     "Replace a privacy policy",
		Description: "Replaces the server-side privacy policy of the project, or of one of its apps with `?app=`. " + how +
			" Patterns are trimmed and deduplicated; one that is not valid RE2 answers `invalid_request` naming it, as does an unknown app. Owners, admins and members only. " + notMember,
		Tags:     tags,
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeInternal), p.put)
}

func privacyDefaults() PrivacyDefaults {
	return PrivacyDefaults{
		MaskQueryParams:  slices.Clone(privacy.DefaultQueryParams),
		MaskHeaders:      slices.Clone(privacy.DefaultHeaders),
		SensitiveHeaders: slices.Clone(privacy.SensitiveHeaders),
		MaskBodyFields:   slices.Clone(privacy.DefaultBodyFields),
	}
}

func toPrivacyPolicy(s privacy.Scoped) PrivacyPolicy {
	out := PrivacyPolicy{
		MaskQueryParams: nonNil(s.Policy.QueryParams),
		MaskHeaders:     nonNil(s.Policy.Headers),
		MaskBodyFields:  nonNil(s.Policy.BodyFields),
		Defaults:        privacyDefaults(),
	}
	if s.App != nil {
		slug := s.App.Slug
		out.App = &slug
	}
	if s.UpdatedAt != nil {
		t := s.UpdatedAt.UTC()
		out.UpdatedAt = &t
	}
	return out
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// problem maps an error of privacy.Service to a problem.
func (p *Privacy) problem(ctx context.Context, op string, err error) error {
	var invalid *privacy.InvalidPatternError
	switch {
	case errors.As(err, &invalid):
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = invalid.Error()
		return pr
	case errors.Is(err, privacy.ErrUnknownApp):
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = "The project has no app with that slug or id."
		return pr
	case errors.Is(err, privacy.ErrNotFound), errors.Is(err, privacy.ErrForbidden):
		return identity.Err(identity.CodeForbidden)
	default:
		p.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (p *Privacy) get(ctx context.Context, in *PrivacyScopeInput) (*PrivacyPolicyOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	s, err := p.svc.Get(ctx, uid, in.Slug, in.App)
	if err != nil {
		return nil, p.problem(ctx, "get privacy policy", err)
	}
	return &PrivacyPolicyOutput{Body: toPrivacyPolicy(s)}, nil
}

func (p *Privacy) put(ctx context.Context, in *PutPrivacyPolicyInput) (*PrivacyPolicyOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	s, err := p.svc.Put(ctx, uid, in.Slug, in.App, privacy.Policy{
		QueryParams: in.Body.MaskQueryParams,
		Headers:     in.Body.MaskHeaders,
		BodyFields:  in.Body.MaskBodyFields,
	})
	if err != nil {
		return nil, p.problem(ctx, "put privacy policy", err)
	}
	return &PrivacyPolicyOutput{Body: toPrivacyPolicy(s)}, nil
}
