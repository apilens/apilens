package identity

import (
	"context"
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
// not available yet.
func ProvidersFor(cfg config.IdentityConfig) AuthProviders {
	return AuthProviders{
		Email:    true,
		Passkeys: true,
		Google:   cfg.OAuth.Google.Enabled(),
		GitHub:   cfg.OAuth.GitHub.Enabled(),
	}
}

// RegisterProviders mounts the public GET /api/v1/auth/providers.
func RegisterProviders(api huma.API, cfg config.IdentityConfig) {
	providers := ProvidersFor(cfg)
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "list-auth-providers",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/providers",
		Summary:     "Enabled sign-in methods",
		Description: "Public. Lists which sign-in methods this deployment offers so the sign-in page shows only working buttons.",
		Tags:        []string{server.TagAuth},
	}), func(context.Context, *struct{}) (*ProvidersOutput, error) {
		return &ProvidersOutput{Body: providers}, nil
	})
}
