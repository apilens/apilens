package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the organization SSO connection endpoints.
const (
	SSOConnectionPath = OrgPath + "/sso"
	SSOTestPath       = SSOConnectionPath + "/test"
)

// SSOService reads, saves, deletes and tests organizations' SSO
// connections; *orgs.SSOConnections satisfies it.
type SSOService interface {
	Get(ctx context.Context, user uuid.UUID, slug string) (orgs.SSOConnection, error)
	Put(ctx context.Context, user uuid.UUID, slug string, set orgs.SSOSettings) (orgs.SSOConnection, bool, error)
	Delete(ctx context.Context, user uuid.UUID, slug string) error
	Test(ctx context.Context, user uuid.UUID, slug, issuer string) (orgs.SSOTestResult, error)
}

// SSOConnectionBody is an organization's OIDC connection. The client secret
// is write-only: reads show a fixed mask.
type SSOConnectionBody struct {
	Issuer       string     `json:"issuer" format:"uri" doc:"The identity provider's issuer URL; discovery is at issuer/.well-known/openid-configuration."`
	ClientID     string     `json:"client_id" doc:"The client registered with the identity provider."`
	ClientSecret string     `json:"client_secret" enum:"********" doc:"Always the mask ********: the secret is write-only. Sending the mask back on PUT keeps the stored secret."`
	Domains      []string   `json:"domains" doc:"Email domains (lower-case hostnames) whose users sign in through this connection."`
	Enforce      bool       `json:"enforce" doc:"Whether users at the domains must sign in through SSO."`
	DefaultRole  string     `json:"default_role" enum:"admin,member,viewer" doc:"Role of a user who joins the organization through their first SSO sign-in."`
	RedirectURI  string     `json:"redirect_uri" format:"uri" doc:"The redirect URI to register with the identity provider."`
	StartURL     string     `json:"start_url" format:"uri" doc:"Where an SSO sign-in to the organization starts."`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	LastLoginAt  *time.Time `json:"last_login_at" required:"true" nullable:"true" doc:"The last successful sign-in through the connection; null if none yet."`
}

// SSOConnectionOutput is the response of GET and PUT
// /api/v1/orgs/{slug}/sso.
type SSOConnectionOutput struct {
	Body SSOConnectionBody
}

// PutSSOConnectionInput is the request of PUT /api/v1/orgs/{slug}/sso.
type PutSSOConnectionInput struct {
	OrgSlugInput
	Body struct {
		Issuer       string   `json:"issuer" minLength:"1" maxLength:"2048" doc:"The identity provider's issuer URL, exactly as its discovery document states it: https (http only on a loopback host), no query or fragment."`
		ClientID     string   `json:"client_id" minLength:"1" maxLength:"255" doc:"The client registered with the identity provider."`
		ClientSecret *string  `json:"client_secret,omitempty" minLength:"1" maxLength:"1024" writeOnly:"true" doc:"The client secret, stored encrypted and never returned. Required for a new connection; omit it (or send ********) to keep the stored one."`
		Domains      []string `json:"domains" minItems:"1" maxItems:"50" doc:"Email domains whose users sign in through this connection: lower-case hostnames, not public email providers (domain_not_allowed). Duplicates are dropped."`
		Enforce      bool     `json:"enforce,omitempty" doc:"Require users at the domains to sign in through SSO. Turning it on needs you to have signed in through this connection at least once (sso_untested)."`
		DefaultRole  string   `json:"default_role,omitempty" enum:"admin,member,viewer" default:"member" doc:"Role of a user who joins through their first SSO sign-in."`
	}
}

// TestSSOConnectionInput is the request of POST /api/v1/orgs/{slug}/sso/test.
type TestSSOConnectionInput struct {
	OrgSlugInput
	Body *struct {
		Issuer string `json:"issuer,omitempty" maxLength:"2048" doc:"Issuer URL to test before saving it; defaults to the saved connection's issuer."`
	} `required:"false"`
}

// SSOTestBody is the outcome of an OIDC discovery test.
type SSOTestBody struct {
	OK                    bool     `json:"ok" doc:"Whether discovery succeeded and the document is usable for sign-in."`
	Issuer                string   `json:"issuer" doc:"The issuer that was tested."`
	Error                 string   `json:"error,omitempty" enum:"unreachable,bad_status,invalid_document,issuer_mismatch,missing_endpoints" doc:"Why the test failed (ok false only)."`
	HTTPStatus            int      `json:"http_status,omitempty" doc:"Status of the discovery response (bad_status only)."`
	AuthorizationEndpoint string   `json:"authorization_endpoint,omitempty"`
	TokenEndpoint         string   `json:"token_endpoint,omitempty"`
	UserinfoEndpoint      string   `json:"userinfo_endpoint,omitempty"`
	JWKSURI               string   `json:"jwks_uri,omitempty"`
	ScopesSupported       []string `json:"scopes_supported,omitempty"`
	ResponseTypes         []string `json:"response_types_supported,omitempty"`
	SigningAlgs           []string `json:"id_token_signing_alg_values_supported,omitempty"`
}

// SSOTestOutput is the response of POST /api/v1/orgs/{slug}/sso/test.
type SSOTestOutput struct {
	Body SSOTestBody
}

// SSOConnections serves the organization SSO connection endpoints.
type SSOConnections struct {
	svc    SSOService
	guard  *authz.Guard
	issuer string
	logger *slog.Logger
}

// NewSSOConnections returns the SSO connection endpoints over svc. issuer is
// the identity issuer URL the redirect and start URLs are under.
func NewSSOConnections(svc SSOService, guard *authz.Guard, issuer string, logger *slog.Logger) *SSOConnections {
	return &SSOConnections{svc: svc, guard: guard, issuer: strings.TrimRight(issuer, "/"), logger: logger}
}

// Register mounts the SSO connection operations. They declare the session
// scheme, so authn.Middleware must be installed on api before.
func (s *SSOConnections) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	guard := huma.Middlewares{s.guard.RequireOrg(api, authz.OrgManage)}
	owners := "Owners only (403 `forbidden` otherwise, 404 `not_found` for an organization the user cannot view)."
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-org-sso",
		Method:      http.MethodGet,
		Path:        SSOConnectionPath,
		Summary:     "Get the organization's SSO connection",
		Description: "Returns the organization's OIDC connection with the redirect URI to register with the identity provider. The client secret is write-only and shows as `********`. " + owners +
			" Answers `sso_not_configured` (409) when there is no connection.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
		Middlewares: guard,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeSSONotConfigured, identity.CodeAuthzUnavailable, identity.CodeInternal), s.get)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "put-org-sso",
		Method:      http.MethodPut,
		Path:        SSOConnectionPath,
		Summary:     "Create or replace the organization's SSO connection",
		Description: "Saves the organization's OIDC connection. The client secret is stored encrypted; omit it (or send `********`) to keep the stored one, a new connection needs one (`invalid_request`). " + owners +
			" Turning `enforce` on needs the caller to have signed in through this connection since it was created (`sso_untested`), and a domain another organization enforces SSO for answers `sso_domain_taken`. " +
			"A public email domain answers `domain_not_allowed`. Audited as `sso.updated`.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
		Middlewares: guard,
	}, identity.CodeInvalidRequest, identity.CodeDomainNotAllowed, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound,
		identity.CodeSSOUntested, identity.CodeSSODomainTaken, identity.CodeAuthzUnavailable, identity.CodeInternal), s.put)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "delete-org-sso",
		Method:        http.MethodDelete,
		Path:          SSOConnectionPath,
		DefaultStatus: http.StatusNoContent,
		Summary:       "Delete the organization's SSO connection",
		Description:   "Removes the organization's OIDC connection; its members sign in by email, social or passkey again. " + owners + " Answers `sso_not_configured` (409) when there is no connection. Audited as `sso.deleted`.",
		Tags:          []string{server.TagOrganizations},
		Security:      security,
		Middlewares:   guard,
	}, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeSSONotConfigured, identity.CodeAuthzUnavailable, identity.CodeInternal), s.delete)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "test-org-sso",
		Method:      http.MethodPost,
		Path:        SSOTestPath,
		Summary:     "Test the organization's SSO connection",
		Description: "Runs OIDC discovery on `issuer` (default: the saved connection's) and reports the identity provider's metadata. " +
			"A provider that cannot be reached or serves an unusable document answers 200 with `ok: false` and an `error`. " + owners +
			" Answers `sso_not_configured` (409) without an `issuer` when there is no connection.",
		Tags:        []string{server.TagOrganizations},
		Security:    security,
		Middlewares: guard,
	}, identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeSSONotConfigured,
		identity.CodeAuthzUnavailable, identity.CodeInternal), s.test)
}

// problem maps an orgs.SSOConnections error to a problem.
func (s *SSOConnections) problem(ctx context.Context, op string, err error) error {
	var notAllowed *orgs.DomainNotAllowedError
	var taken *orgs.SSODomainTakenError
	switch {
	case errors.Is(err, orgs.ErrNotFound):
		return identity.Err(identity.CodeNotFound)
	case errors.Is(err, orgs.ErrForbidden):
		return identity.Err(identity.CodeForbidden)
	case errors.Is(err, orgs.ErrSSONotConfigured):
		return identity.Err(identity.CodeSSONotConfigured)
	case errors.Is(err, orgs.ErrSSOUntested):
		return identity.Err(identity.CodeSSOUntested)
	case errors.As(err, &taken):
		return identity.Err(identity.CodeSSODomainTaken)
	case errors.As(err, &notAllowed):
		return identity.Err(identity.CodeDomainNotAllowed)
	case errors.Is(err, orgs.ErrInvalid), errors.Is(err, orgs.ErrSSOSecretRequired):
		return identity.Err(identity.CodeInvalidRequest)
	default:
		s.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func (s *SSOConnections) body(c orgs.SSOConnection) SSOConnectionBody {
	var last *time.Time
	if c.LastLoginAt != nil {
		t := c.LastLoginAt.UTC()
		last = &t
	}
	return SSOConnectionBody{
		Issuer:       c.Issuer,
		ClientID:     c.ClientID,
		ClientSecret: orgs.SSOSecretMask,
		Domains:      c.Domains,
		Enforce:      c.Enforce,
		DefaultRole:  c.DefaultRole,
		RedirectURI:  s.issuer + identity.AuthPrefix + "/sso/" + url.PathEscape(c.Slug) + "/callback",
		StartURL:     identity.SSOStartURL(s.issuer, c.Slug),
		CreatedAt:    c.CreatedAt.UTC(),
		UpdatedAt:    c.UpdatedAt.UTC(),
		LastLoginAt:  last,
	}
}

func (s *SSOConnections) get(ctx context.Context, in *OrgSlugInput) (*SSOConnectionOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	c, err := s.svc.Get(ctx, uid, in.Slug)
	if err != nil {
		return nil, s.problem(ctx, "get sso connection", err)
	}
	return &SSOConnectionOutput{Body: s.body(c)}, nil
}

func (s *SSOConnections) put(ctx context.Context, in *PutSSOConnectionInput) (*SSOConnectionOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	role := in.Body.DefaultRole
	if role == "" {
		role = "member"
	}
	c, _, err := s.svc.Put(ctx, uid, in.Slug, orgs.SSOSettings{
		Issuer:       in.Body.Issuer,
		ClientID:     in.Body.ClientID,
		ClientSecret: in.Body.ClientSecret,
		Domains:      in.Body.Domains,
		Enforce:      in.Body.Enforce,
		DefaultRole:  role,
	})
	if err != nil {
		return nil, s.problem(ctx, "save sso connection", err)
	}
	return &SSOConnectionOutput{Body: s.body(c)}, nil
}

func (s *SSOConnections) delete(ctx context.Context, in *OrgSlugInput) (*struct{}, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.svc.Delete(ctx, uid, in.Slug); err != nil {
		return nil, s.problem(ctx, "delete sso connection", err)
	}
	return nil, nil
}

func (s *SSOConnections) test(ctx context.Context, in *TestSSOConnectionInput) (*SSOTestOutput, error) {
	uid, err := signedInUser(ctx)
	if err != nil {
		return nil, err
	}
	var issuer string
	if in.Body != nil {
		issuer = in.Body.Issuer
	}
	r, err := s.svc.Test(ctx, uid, in.Slug, issuer)
	if err != nil {
		return nil, s.problem(ctx, "test sso connection", err)
	}
	return &SSOTestOutput{Body: SSOTestBody{
		OK:                    r.OK,
		Issuer:                r.Issuer,
		Error:                 r.Error,
		HTTPStatus:            r.HTTPStatus,
		AuthorizationEndpoint: r.AuthorizationEndpoint,
		TokenEndpoint:         r.TokenEndpoint,
		UserinfoEndpoint:      r.UserinfoEndpoint,
		JWKSURI:               r.JWKSURI,
		ScopesSupported:       r.ScopesSupported,
		ResponseTypes:         r.ResponseTypes,
		SigningAlgs:           r.SigningAlgs,
	}}, nil
}
