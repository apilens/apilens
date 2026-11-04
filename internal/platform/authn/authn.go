// Package authn authenticates callers of the typed API and carries who they
// are through the request context.
//
// Three kinds of callers exist: users, holding an access token (an RS256 JWT
// issued by the identity role, verified here against its JWKS); OAuth
// clients acting for themselves, holding a client_credentials access token
// from identity's OIDC provider (same keys, `sub` = `client_id`); and API
// keys, verified by the control plane. All end up as a Principal, so
// handlers and authorization code read one type whatever the credential.
//
// Operations opt in through their OpenAPI security requirement: one naming
// SchemeSession is guarded by Middleware. The package sits in platform so
// every role (api, query, later mcp) can use it without importing identity.
package authn

import (
	"context"
	"slices"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// SchemeSession is the OpenAPI security scheme of user access tokens.
const SchemeSession = "session"

// Kind tells what credential authenticated a Principal.
type Kind string

// Principal kinds.
const (
	KindUser   Kind = "user"
	KindClient Kind = "client"
	KindAPIKey Kind = "apikey"
)

// Principal is an authenticated caller.
type Principal struct {
	Kind Kind

	// User fields (KindUser): the token's `sub`, `sid` and `amr`.
	UserID    uuid.UUID
	SessionID uuid.UUID
	AMR       []string

	// OAuth client fields (KindClient): the token's `client_id` (= `sub`).
	ClientID string

	// API key fields (KindAPIKey).
	KeyID     uuid.UUID
	ProjectID uuid.UUID
	OrgID     uuid.UUID
	Scopes    []string
}

// HasScope reports whether an API key principal carries scope.
func (p Principal) HasScope(scope string) bool { return slices.Contains(p.Scopes, scope) }

type principalKey struct{}

// WithPrincipal returns ctx carrying p.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// FromContext returns the Principal a middleware stored in ctx.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// SecurityScheme is the OpenAPI description of SchemeSession.
func SecurityScheme() *huma.SecurityScheme {
	return &huma.SecurityScheme{
		Type:         "http",
		Scheme:       "bearer",
		BearerFormat: "JWT",
		Description:  "User access token: a 15-minute RS256 JWT issued by identity, verifiable against `/.well-known/jwks.json`.",
	}
}

// AddSecurityScheme documents SchemeSession in api's OpenAPI document.
func AddSecurityScheme(api huma.API) {
	oa := api.OpenAPI()
	if oa.Components == nil {
		oa.Components = &huma.Components{}
	}
	if oa.Components.SecuritySchemes == nil {
		oa.Components.SecuritySchemes = map[string]*huma.SecurityScheme{}
	}
	oa.Components.SecuritySchemes[SchemeSession] = SecurityScheme()
}

// Declares reports whether op lists scheme among its security requirements.
func Declares(op *huma.Operation, scheme string) bool {
	if op == nil {
		return false
	}
	for _, req := range op.Security {
		if _, ok := req[scheme]; ok {
			return true
		}
	}
	return false
}
