package oidcprovider

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// client is a registered client (op.Client).
type client struct {
	row        db.OauthClient
	loginURL   string
	idTokenTTL time.Duration
}

var _ op.Client = (*client)(nil)

func (c *client) GetID() string                    { return c.row.ID }
func (c *client) RedirectURIs() []string           { return slices.Clone(c.row.RedirectUris) }
func (c *client) PostLogoutRedirectURIs() []string { return nil }

func (c *client) ApplicationType() op.ApplicationType {
	if c.row.ApplicationType == "native" {
		return op.ApplicationTypeNative
	}
	return op.ApplicationTypeWeb
}

func (c *client) AuthMethod() oidc.AuthMethod { return oidc.AuthMethod(c.row.AuthMethod) }

// ResponseTypes: the authorization code flow only (no implicit or hybrid).
func (c *client) ResponseTypes() []oidc.ResponseType {
	return []oidc.ResponseType{oidc.ResponseTypeCode}
}

func (c *client) GrantTypes() []oidc.GrantType {
	out := make([]oidc.GrantType, 0, len(c.row.GrantTypes))
	for _, g := range c.row.GrantTypes {
		out = append(out, oidc.GrantType(g))
	}
	return out
}

// LoginURL is the UI page that signs the user in for request id.
func (c *client) LoginURL(id string) string {
	return c.loginURL + "?" + url.Values{"request_id": {id}}.Encode()
}

func (c *client) AccessTokenType() op.AccessTokenType { return op.AccessTokenTypeJWT }
func (c *client) IDTokenLifetime() time.Duration      { return c.idTokenTTL }
func (c *client) DevMode() bool                       { return false }

func (c *client) RestrictAdditionalIdTokenScopes() func([]string) []string {
	return func(scopes []string) []string { return scopes }
}

func (c *client) RestrictAdditionalAccessTokenScopes() func([]string) []string {
	return func(scopes []string) []string { return scopes }
}

// IsScopeAllowed: no scopes beyond the standard OIDC ones exist yet.
func (c *client) IsScopeAllowed(string) bool { return false }

func (c *client) IDTokenUserinfoClaimsAssertion() bool { return false }
func (c *client) ClockSkew() time.Duration             { return 0 }

// checkSecret compares secret with the client's stored hash in constant
// time. A public client has no secret and never matches.
func checkSecret(row db.OauthClient, secret string) bool {
	if row.SecretHash == nil || secret == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(*row.SecretHash), []byte(hashToken(secret))) == 1
}

// NewClient describes a client to register.
type NewClient struct {
	// Name is shown to users on the sign-in page.
	Name string
	// Public clients (a CLI, a native app) have no secret and must use PKCE.
	Public bool
	// AuthMethod of a confidential client: client_secret_basic (default) or
	// client_secret_post.
	AuthMethod string
	// Native marks an installed application (loopback redirect URIs).
	Native       bool
	RedirectURIs []string
	// GrantTypes from GrantTypes; default authorization_code.
	GrantTypes []string
}

// RegisteredClient is a new client with its secret, shown once.
type RegisteredClient struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret,omitempty"`
	AuthMethod   string   `json:"token_endpoint_auth_method"`
	RedirectURIs []string `json:"redirect_uris"`
	GrantTypes   []string `json:"grant_types"`
}

// ErrInvalidClient means a NewClient is not a valid registration.
var ErrInvalidClient = errors.New("oidcprovider: invalid client")

// RegisterClient stores a new client with a random id and, unless it is
// public, a random secret. Operators run it through `apilens identity
// create-client` until M4 adds dynamic registration.
func RegisterClient(ctx context.Context, q db.Querier, nc NewClient) (RegisteredClient, error) {
	grants := nc.GrantTypes
	if len(grants) == 0 {
		grants = []string{string(oidc.GrantTypeCode)}
	}
	for _, g := range grants {
		if !slices.Contains(GrantTypes, g) {
			return RegisteredClient{}, fmt.Errorf("%w: unknown grant type %q", ErrInvalidClient, g)
		}
	}
	userFlow := slices.Contains(grants, string(oidc.GrantTypeCode))
	if userFlow && len(nc.RedirectURIs) == 0 {
		return RegisteredClient{}, fmt.Errorf("%w: authorization_code needs at least one redirect URI", ErrInvalidClient)
	}
	if slices.Contains(grants, string(oidc.GrantTypeRefreshToken)) && !userFlow {
		return RegisteredClient{}, fmt.Errorf("%w: refresh_token needs authorization_code", ErrInvalidClient)
	}
	for _, u := range nc.RedirectURIs {
		if err := checkRedirectURI(u); err != nil {
			return RegisteredClient{}, fmt.Errorf("%w: redirect URI %q: %w", ErrInvalidClient, u, err)
		}
	}
	method := nc.AuthMethod
	switch {
	case nc.Public:
		if method != "" && method != string(oidc.AuthMethodNone) {
			return RegisteredClient{}, fmt.Errorf("%w: a public client has no secret to authenticate with", ErrInvalidClient)
		}
		if slices.Contains(grants, string(oidc.GrantTypeClientCredentials)) {
			return RegisteredClient{}, fmt.Errorf("%w: client_credentials needs a confidential client", ErrInvalidClient)
		}
		method = string(oidc.AuthMethodNone)
	case method == "":
		method = string(oidc.AuthMethodBasic)
	case method != string(oidc.AuthMethodBasic) && method != string(oidc.AuthMethodPost):
		return RegisteredClient{}, fmt.Errorf("%w: auth method %q (want client_secret_basic or client_secret_post)", ErrInvalidClient, method)
	}

	id, err := randomToken(16)
	if err != nil {
		return RegisteredClient{}, err
	}
	out := RegisteredClient{ClientID: id, AuthMethod: method, RedirectURIs: nonNil(nc.RedirectURIs), GrantTypes: grants}
	var secretHash *string
	if !nc.Public {
		if out.ClientSecret, err = randomToken(32); err != nil {
			return RegisteredClient{}, err
		}
		h := hashToken(out.ClientSecret)
		secretHash = &h
	}
	appType := "web"
	if nc.Native {
		appType = "native"
	}
	if _, err := q.CreateOAuthClient(ctx, db.CreateOAuthClientParams{
		ID: id, Name: strings.TrimSpace(nc.Name), SecretHash: secretHash, AuthMethod: method,
		ApplicationType: appType, RedirectUris: out.RedirectURIs, GrantTypes: grants,
	}); err != nil {
		return RegisteredClient{}, fmt.Errorf("oidcprovider: create client: %w", err)
	}
	return out, nil
}

// checkRedirectURI requires an absolute URI without a fragment (RFC 6749
// §3.1.2).
func checkRedirectURI(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if !u.IsAbs() || u.Fragment != "" || (u.Host == "" && u.Opaque == "") {
		return errors.New("want an absolute URI without a fragment")
	}
	return nil
}

// randomToken returns n random bytes, base64url-encoded.
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("oidcprovider: random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
