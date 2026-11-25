package identity

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
)

// AuthProviders lists the sign-in methods this deployment offers, so the UI can
// hide buttons for disabled ones.
type AuthProviders struct {
	Email    bool `json:"email" doc:"Email code / magic link sign-in. Always enabled."`
	Passkeys bool `json:"passkeys" doc:"Passkey (WebAuthn) sign-in. Always enabled."`
	Google   bool `json:"google" doc:"Sign in with Google (identity.oauth.google is configured)."`
	GitHub   bool `json:"github" doc:"Sign in with GitHub (identity.oauth.github is configured)."`
	SSO      bool `json:"sso" doc:"Enterprise SSO (SAML/OIDC) is available."`
}

// ProvidersOutput is the response of GET /api/v1/auth/providers.
type ProvidersOutput struct {
	Body AuthProviders
}

// ProvidersFor derives the enabled sign-in methods from cfg. Email and
// passkeys are built in; Google and GitHub follow their client IDs. SSO is
// set per request by RegisterProviders.
func ProvidersFor(cfg config.IdentityConfig) AuthProviders {
	return AuthProviders{
		Email:    true,
		Passkeys: true,
		Google:   cfg.OAuth.Google.Enabled(),
		GitHub:   cfg.OAuth.GitHub.Enabled(),
	}
}

// SSOAvailability reports whether any organization signs in with SSO;
// *db.Queries satisfies it.
type SSOAvailability interface {
	AnySSOConnection(ctx context.Context) (bool, error)
}

// RegisterProviders mounts the public GET /api/v1/auth/providers. sso may be
// nil (SSO is then never offered); a failed lookup answers sso false.
func RegisterProviders(api huma.API, cfg config.IdentityConfig, sso SSOAvailability) {
	base := ProvidersFor(cfg)
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "list-auth-providers",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/providers",
		Summary:     "Enabled sign-in methods",
		Description: "Public. Lists which sign-in methods this deployment offers so the sign-in page shows only working buttons.",
		Tags:        []string{server.TagAuth},
	}), func(ctx context.Context, _ *struct{}) (*ProvidersOutput, error) {
		providers := base
		if sso != nil {
			found, err := sso.AnySSOConnection(ctx)
			if err != nil {
				slog.WarnContext(ctx, "auth providers: sso lookup failed", "error", err)
			}
			providers.SSO = err == nil && found
		}
		return &ProvidersOutput{Body: providers}, nil
	})
}
