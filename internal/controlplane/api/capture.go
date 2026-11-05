package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// CapturePolicyPath is an app's remote capture policy endpoint.
const CapturePolicyPath = server.APIPrefix + "/apps/{id}/capture-policy"

// AppMetadataPath is an app's reported SDK metadata endpoint.
const AppMetadataPath = server.APIPrefix + "/apps/{id}/metadata"

// CaptureService reads and replaces capture policies; *capture.Service
// satisfies it.
type CaptureService interface {
	App(ctx context.Context, id uuid.UUID) (capture.App, error)
	Get(ctx context.Context, app capture.App) (capture.Stored, error)
	Put(ctx context.Context, actor uuid.UUID, app capture.App, pol capture.Policy) (capture.Stored, error)
	Metadata(ctx context.Context, app capture.App) ([]capture.Metadata, error)
}

// ProjectAuthorizer checks a permission on a project named by slug;
// *authz.Guard satisfies it.
type ProjectAuthorizer interface {
	AuthorizeProject(ctx context.Context, p authn.Principal, slug string, permission authz.Permission) (authz.Target, error)
}

// CapturePolicy is the remote capture policy of an app, sent to its SDKs on
// heartbeat.
type CapturePolicy struct {
	AppID               string     `json:"app_id" format:"uuid" doc:"The app's id."`
	App                 string     `json:"app" doc:"The app's slug."`
	Project             string     `json:"project" doc:"The slug of the app's project."`
	Enabled             bool       `json:"enabled" doc:"Whether the app's SDKs capture at all; false tells them to stop sending records."`
	SampleRate          float64    `json:"sample_rate" minimum:"0" maximum:"1" doc:"Fraction of requests the SDKs keep, from 0 to 1."`
	CaptureHeaders      bool       `json:"capture_headers" doc:"Whether request and response headers are captured."`
	CaptureRequestBody  bool       `json:"capture_request_body" doc:"Whether request bodies are captured."`
	CaptureResponseBody bool       `json:"capture_response_body" doc:"Whether response bodies are captured."`
	MaxPayloadBytes     *int       `json:"max_payload_bytes" required:"true" nullable:"true" doc:"Cap on each captured body in bytes; null means no cap beyond the SDK's own."`
	UpdatedAt           *time.Time `json:"updated_at" required:"true" nullable:"true" doc:"When the policy was last saved; null if it never was (the app captures everything)."`
	UpdatedBy           *string    `json:"updated_by" required:"true" nullable:"true" format:"uuid" doc:"The user who last saved the policy; null if it never was saved or that user is gone."`
}

// CapturePolicyOutput is the response of the capture policy operations.
type CapturePolicyOutput struct {
	Body CapturePolicy
}

// AppEnvironmentReport is the latest metadata report of an app's SDK in one
// environment.
type AppEnvironmentReport struct {
	Environment      string         `json:"environment" doc:"The environment the SDK reported from."`
	Framework        string         `json:"framework" doc:"The web framework the SDK instruments; empty if not reported."`
	FrameworkVersion string         `json:"framework_version" doc:"The framework's version; empty if not reported."`
	RuntimeVersion   string         `json:"runtime_version" doc:"The language runtime's version; empty if not reported."`
	SdkVersion       string         `json:"sdk_version" doc:"The SDK's version; empty if not reported."`
	Config           map[string]any `json:"config" doc:"The effective SDK config as the SDK reported it (capture flags, redaction patterns, exclusions, sample rate; callbacks as true)."`
	ReceivedAt       time.Time      `json:"received_at" doc:"When the report arrived."`
}

// AppReports is what an app's SDKs reported about themselves on startup.
type AppReports struct {
	AppID        string                 `json:"app_id" format:"uuid" doc:"The app's id."`
	Environments []AppEnvironmentReport `json:"environments" doc:"The latest report per environment, sorted by environment; empty if the SDKs never sent one."`
}

// AppReportsOutput is the response of GET /api/v1/apps/{id}/metadata.
type AppReportsOutput struct {
	Body AppReports
}

// CaptureAppInput names the app by id.
type CaptureAppInput struct {
	ID string `path:"id" format:"uuid" doc:"The app's id."`
}

// PutCapturePolicyInput is the request of PUT
// /api/v1/apps/{id}/capture-policy.
type PutCapturePolicyInput struct {
	CaptureAppInput
	Body struct {
		Enabled             bool    `json:"enabled" doc:"Whether the app's SDKs capture at all."`
		SampleRate          float64 `json:"sample_rate" minimum:"0" maximum:"1" doc:"Fraction of requests the SDKs keep, from 0 to 1, at most 4 decimal places."`
		CaptureHeaders      bool    `json:"capture_headers" doc:"Whether request and response headers are captured."`
		CaptureRequestBody  bool    `json:"capture_request_body" doc:"Whether request bodies are captured."`
		CaptureResponseBody bool    `json:"capture_response_body" doc:"Whether response bodies are captured."`
		MaxPayloadBytes     *int    `json:"max_payload_bytes,omitempty" minimum:"1" maximum:"1048576" nullable:"true" doc:"Cap on each captured body in bytes (1 to 1048576); omitted or null means no cap beyond the SDK's own."`
	}
}

// CapturePolicies serves the capture policy endpoints.
type CapturePolicies struct {
	svc    CaptureService
	authz  ProjectAuthorizer
	logger *slog.Logger
}

// NewCapturePolicies returns the capture policy endpoints over svc,
// authorized by guard (nil refuses every request with authz_unavailable).
func NewCapturePolicies(svc CaptureService, guard ProjectAuthorizer, logger *slog.Logger) *CapturePolicies {
	return &CapturePolicies{svc: svc, authz: guard, logger: logger}
}

// Register mounts the capture policy operations. They declare the session
// scheme, so authn.Middleware must be installed on api before.
func (c *CapturePolicies) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	tags := []string{server.TagProjects}
	how := "An app without a saved policy captures everything (enabled, `sample_rate` 1, headers and bodies on, no extra payload cap). " +
		"SDKs receive the policy on heartbeat; edges pick a change up within the app cache TTL (`ingest.app_cache_ttl`, 60 s by default). " +
		"An unknown app, or one in a project the caller cannot view, answers 404 `not_found`, so the cases cannot be told apart."

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-capture-policy",
		Method:      http.MethodGet,
		Path:        CapturePolicyPath,
		Summary:     "Get an app's capture policy",
		Description: "Returns the remote capture policy of the app. Needs `view` on its project (any member, including viewers). " + how,
		Tags:        tags,
		Security:    security,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), c.get)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "put-capture-policy",
		Method:      http.MethodPut,
		Path:        CapturePolicyPath,
		Summary:     "Replace an app's capture policy",
		Description: "Replaces the remote capture policy of the app. Needs `manage_capture` on its project (project admins, organization owners and admins; 403 `forbidden` for other members). " +
			"A `sample_rate` with more than 4 decimal places answers `invalid_request`. Audited as `capture_policy.updated`. " + how,
		Tags:     tags,
		Security: security,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), c.put)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-app-metadata",
		Method:      http.MethodGet,
		Path:        AppMetadataPath,
		Summary:     "Get what an app's SDKs reported on startup",
		Description: "Returns the latest metadata report (POST /v1/metadata) of the app per environment: framework, versions and the effective SDK config, " +
			"so it can be shown next to the remote capture policy (the SDK applies the narrower of the two). The route list is left out. " +
			"Needs `view` on its project (any member, including viewers). " +
			"An unknown app, or one in a project the caller cannot view, answers 404 `not_found`, so the cases cannot be told apart.",
		Tags:     tags,
		Security: security,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), c.metadata)
}

// authorize resolves the app and checks permission on its project.
func (c *CapturePolicies) authorize(ctx context.Context, p authn.Principal, id string, permission authz.Permission) (capture.App, error) {
	appID, err := uuid.Parse(id)
	if err != nil {
		return capture.App{}, identity.Err(identity.CodeNotFound)
	}
	app, err := c.svc.App(ctx, appID)
	if err != nil {
		return capture.App{}, c.problem(ctx, "resolve app", err)
	}
	if c.authz == nil {
		return capture.App{}, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	t, err := c.authz.AuthorizeProject(ctx, p, app.ProjectSlug, permission)
	switch {
	case err == nil && t.ProjectID == app.ProjectID:
		return app, nil
	case err == nil, errors.Is(err, authz.ErrNoResource):
		// The slug now names another project (the app's was deleted).
		return capture.App{}, identity.Err(identity.CodeNotFound)
	case errors.Is(err, authz.ErrForbidden):
		return capture.App{}, identity.Err(identity.CodeForbidden)
	case errors.Is(err, authz.ErrUnavailable):
		return capture.App{}, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	default:
		c.logger.ErrorContext(ctx, "authorize capture policy", "error", err)
		return capture.App{}, identity.Err(identity.CodeInternal)
	}
}

// problem maps an error of capture.Service to a problem.
func (c *CapturePolicies) problem(ctx context.Context, op string, err error) error {
	var invalid *capture.InvalidError
	switch {
	case errors.As(err, &invalid):
		pr := identity.Err(identity.CodeInvalidRequest)
		pr.Detail = invalid.Error()
		return pr
	case errors.Is(err, capture.ErrUnknownApp):
		return identity.Err(identity.CodeNotFound)
	default:
		c.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func toCapturePolicy(s capture.Stored) CapturePolicy {
	out := CapturePolicy{
		AppID:               s.App.ID.String(),
		App:                 s.App.Slug,
		Project:             s.App.ProjectSlug,
		Enabled:             s.Policy.Enabled,
		SampleRate:          s.Policy.SampleRate,
		CaptureHeaders:      s.Policy.CaptureHeaders,
		CaptureRequestBody:  s.Policy.CaptureRequestBody,
		CaptureResponseBody: s.Policy.CaptureResponseBody,
		MaxPayloadBytes:     s.Policy.MaxPayloadBytes,
	}
	if s.UpdatedAt != nil {
		t := s.UpdatedAt.UTC()
		out.UpdatedAt = &t
	}
	if s.UpdatedBy != nil {
		u := s.UpdatedBy.String()
		out.UpdatedBy = &u
	}
	return out
}

func (c *CapturePolicies) get(ctx context.Context, in *CaptureAppInput) (*CapturePolicyOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	app, err := c.authorize(ctx, p, in.ID, authz.ProjectView)
	if err != nil {
		return nil, err
	}
	s, err := c.svc.Get(ctx, app)
	if err != nil {
		return nil, c.problem(ctx, "get capture policy", err)
	}
	return &CapturePolicyOutput{Body: toCapturePolicy(s)}, nil
}

func (c *CapturePolicies) put(ctx context.Context, in *PutCapturePolicyInput) (*CapturePolicyOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	p, _ := authn.FromContext(ctx)
	app, err := c.authorize(ctx, p, in.ID, authz.ProjectManageCapture)
	if err != nil {
		return nil, err
	}
	s, err := c.svc.Put(ctx, uid, app, capture.Policy{
		Enabled:             in.Body.Enabled,
		SampleRate:          in.Body.SampleRate,
		CaptureHeaders:      in.Body.CaptureHeaders,
		CaptureRequestBody:  in.Body.CaptureRequestBody,
		CaptureResponseBody: in.Body.CaptureResponseBody,
		MaxPayloadBytes:     in.Body.MaxPayloadBytes,
	})
	if err != nil {
		return nil, c.problem(ctx, "put capture policy", err)
	}
	return &CapturePolicyOutput{Body: toCapturePolicy(s)}, nil
}

func (c *CapturePolicies) metadata(ctx context.Context, in *CaptureAppInput) (*AppReportsOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	app, err := c.authorize(ctx, p, in.ID, authz.ProjectView)
	if err != nil {
		return nil, err
	}
	reports, err := c.svc.Metadata(ctx, app)
	if err != nil {
		return nil, c.problem(ctx, "get app metadata", err)
	}
	out := AppReports{AppID: app.ID.String(), Environments: make([]AppEnvironmentReport, 0, len(reports))}
	for _, m := range reports {
		out.Environments = append(out.Environments, AppEnvironmentReport{
			Environment:      m.Environment,
			Framework:        m.Framework,
			FrameworkVersion: m.FrameworkVersion,
			RuntimeVersion:   m.RuntimeVersion,
			SdkVersion:       m.SdkVersion,
			Config:           m.Config,
			ReceivedAt:       m.ReceivedAt,
		})
	}
	return &AppReportsOutput{Body: out}, nil
}
