// Package oidcprovider makes the identity role an OpenID Connect provider
// and OAuth 2.0 authorization server (ADR 0005), built on zitadel/oidc's op
// package. MCP clients, agents and service accounts get tokens from it; M4
// adds client registration (CIMD/DCR) and token exchange on top.
//
// # Endpoints
//
// Mounted on the identity role when identity.oidc_provider.enabled is set:
//
//	GET  /.well-known/openid-configuration   discovery
//	GET  /oauth/authorize                    authorization request → UI sign-in
//	GET  /oauth/authorize/callback?id=       back from the UI → code to the client
//	POST /oauth/token                        authorization_code (+PKCE), client_credentials, refresh_token
//	GET  /oauth/userinfo                     claims of the signed-in user
//	POST /oauth/revoke, /oauth/introspect    RFC 7009 / RFC 7662
//
// The public signing keys are the ones identity already serves at
// /.well-known/jwks.json; ID and access tokens are signed with the same
// active key as session access tokens (package keys).
//
// # Signing in
//
// Identity sets no cookies, so it cannot tell who is signed in. An
// authorization request is stored (oauth_auth_requests) and the browser is
// sent to the UI at identity.public_ui_url + LoginPath. The UI signs the
// user in as usual, then calls Service.Complete (POST
// /api/v1/auth/oidc/requests/{id}/complete with the user's session) to bind
// the user to the request, and navigates to the callback URL it returns.
// The callback issues the code.
//
// # Tokens
//
// Access tokens are RS256 JWTs. A client_credentials token has `sub` =
// `client_id` = the client and `aud` = "apilens", so the api role's session
// verifier accepts it as a client principal. Tokens issued to a client on a
// user's behalf have `aud` = the client only: they are for /oauth/userinfo
// and are not accepted by the API until M4 defines delegated scopes. Every
// access token has an oauth_tokens row (its `jti`), which userinfo, refresh
// and revocation check.
package oidcprovider

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/rs/cors"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
	"golang.org/x/text/language"
)

// Paths served by the provider, relative to identity.issuer.
const (
	DiscoveryPath     = oidc.DiscoveryEndpoint // /.well-known/openid-configuration
	AuthorizePath     = "/oauth/authorize"
	CallbackPath      = AuthorizePath + "/callback"
	TokenPath         = "/oauth/token" //nolint:gosec // G101: a URL path, not a credential
	UserinfoPath      = "/oauth/userinfo"
	RevokePath        = "/oauth/revoke"
	IntrospectPath    = "/oauth/introspect"
	EndSessionPath    = "/oauth/end_session"
	DeviceAuthPath    = "/oauth/device_authorization"
	oauthPrefix       = "/oauth/"
	defaultJWKSPath   = "/.well-known/jwks.json"
	callbackErrorName = "error"
)

// LoginPath is the UI page an authorization request is sent to, relative to
// identity.public_ui_url. It receives `request_id`.
const LoginPath = "/auth/oidc"

// Audience is the `aud` of a client_credentials access token: the APILens
// API. It equals authn.Audience.
const Audience = "apilens"

// Lifetimes of the authorization flow.
const (
	// AuthRequestTTL bounds the time from /oauth/authorize to the code.
	AuthRequestTTL = 10 * time.Minute
	// CodeTTL bounds the time from the code to its redemption.
	CodeTTL = 2 * time.Minute
)

// Scopes the provider understands. Others are dropped from requests.
var Scopes = []string{oidc.ScopeOpenID, oidc.ScopeProfile, oidc.ScopeEmail, oidc.ScopeOfflineAccess}

// Grant types a client may be registered for.
var GrantTypes = []string{string(oidc.GrantTypeCode), string(oidc.GrantTypeRefreshToken), string(oidc.GrantTypeClientCredentials)}

// Errors the UI may send back to the callback instead of signing the user
// in (`?error=`): the user is not signed in and the client asked for no
// interaction, or the user declined.
var callbackErrors = map[string]func() *oidc.Error{
	string(oidc.LoginRequired):       oidc.ErrLoginRequired,
	string(oidc.AccessDenied):        oidc.ErrAccessDenied,
	string(oidc.InteractionRequired): oidc.ErrInteractionRequired,
}

// Options configures the provider.
type Options struct {
	// Issuer is identity.issuer: the `iss` of every token and the base of
	// every endpoint.
	Issuer string
	// PublicUIURL is identity.public_ui_url; the UI sign-in for an
	// authorization request is PublicUIURL + LoginPath.
	PublicUIURL string
	// AccessTokenTTL is the lifetime of access and ID tokens.
	AccessTokenTTL time.Duration
	// RefreshTokenTTL is the absolute lifetime of a refresh token family.
	RefreshTokenTTL time.Duration
	// CryptoKey encrypts authorization codes. Derive it with DeriveCryptoKey.
	CryptoKey [32]byte
	// Now returns the current time. Nil means time.Now.
	Now func() time.Time
}

// DeriveCryptoKey derives the provider's code-encryption key from the
// identity key-encryption key, so no new secret has to be configured.
func DeriveCryptoKey(kek []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte("apilens/oidc-provider/crypto-key\x00"))
	h.Write(kek)
	var k [32]byte
	copy(k[:], h.Sum(nil))
	return k
}

// Provider is the mounted OpenID provider.
type Provider struct {
	op      *op.Provider
	storage *Storage
}

// New builds the provider over storage.
func New(storage *Storage) (*Provider, error) {
	o := storage.opts
	cfg := &op.Config{
		CryptoKey:                o.CryptoKey,
		CodeMethodS256:           true,
		AuthMethodPost:           true,
		AuthMethodPrivateKeyJWT:  false,
		GrantTypeRefreshToken:    true,
		RequestObjectSupported:   false,
		SupportedUILocales:       []language.Tag{language.English},
		SupportedScopes:          Scopes,
		SupportedClaims:          supportedClaims,
		DefaultLogoutRedirectURI: strings.TrimRight(o.PublicUIURL, "/") + "/",
	}
	opts := []op.Option{
		op.WithCustomAuthEndpoint(op.NewEndpoint(AuthorizePath)),
		op.WithCustomTokenEndpoint(op.NewEndpoint(TokenPath)),
		op.WithCustomUserinfoEndpoint(op.NewEndpoint(UserinfoPath)),
		op.WithCustomRevocationEndpoint(op.NewEndpoint(RevokePath)),
		op.WithCustomIntrospectionEndpoint(op.NewEndpoint(IntrospectPath)),
		op.WithCustomEndSessionEndpoint(op.NewEndpoint(EndSessionPath)),
		op.WithCustomKeysEndpoint(op.NewEndpoint(defaultJWKSPath)),
		op.WithCustomDeviceAuthorizationEndpoint(op.NewEndpoint(DeviceAuthPath)),
		// Identity sets no cookies, so cross-origin calls (a browser-based
		// public client at the token endpoint) never carry credentials.
		op.WithCORSOptions(&corsOptions),
	}
	if u, err := url.Parse(o.Issuer); err == nil && u.Scheme == "http" {
		// Local development serves the issuer over plain HTTP.
		opts = append(opts, op.WithAllowInsecure())
	}
	p, err := op.NewProvider(cfg, storage, op.StaticIssuer(o.Issuer), opts...)
	if err != nil {
		return nil, err
	}
	return &Provider{op: p, storage: storage}, nil
}

// supportedClaims are the claims identity can put in ID tokens and userinfo.
var supportedClaims = []string{
	"sub", "aud", "exp", "iat", "iss", "auth_time", "nonce", "amr", "at_hash", "c_hash", "azp",
	"client_id", "name", "picture", "updated_at", "email", "email_verified",
}

// Mount registers the provider's endpoints on mux. The JWKS stays served by
// identity.RegisterJWKS.
func (p *Provider) Mount(mux *http.ServeMux) {
	mux.Handle(DiscoveryPath, p.op)
	mux.Handle(oauthPrefix, noStore(callbackErrorsHandler(p, p.op)))
}

// Handler returns the provider's endpoints for tests.
func (p *Provider) Handler() http.Handler {
	mux := http.NewServeMux()
	p.Mount(mux)
	return mux
}

// callbackErrorsHandler lets the UI end an authorization request without a
// sign-in: GET /oauth/authorize/callback?id=…&error=login_required (or
// access_denied, interaction_required) answers the client
// with that error and deletes the request. Everything else goes to next.
func callbackErrorsHandler(p *Provider, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != CallbackPath || !r.URL.Query().Has(callbackErrorName) {
			next.ServeHTTP(w, r)
			return
		}
		mk, ok := callbackErrors[r.URL.Query().Get(callbackErrorName)]
		if !ok {
			http.Error(w, "unsupported error", http.StatusBadRequest)
			return
		}
		ctx := op.ContextWithIssuer(r.Context(), p.storage.opts.Issuer)
		req, err := p.storage.AuthRequestByID(ctx, r.URL.Query().Get("id"))
		if err != nil {
			http.Error(w, "unknown or expired authorization request", http.StatusBadRequest)
			return
		}
		if err := p.storage.DeleteAuthRequest(ctx, req.GetID()); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		op.AuthRequestError(w, r.WithContext(ctx), req, mk(), p.op)
	})
}

// corsOptions allow any origin without credentials: identity sets no
// cookies, and a browser-based public client must reach the token endpoint.
var corsOptions = cors.Options{
	AllowedOrigins: []string{"*"},
	AllowedMethods: []string{http.MethodGet, http.MethodHead, http.MethodPost},
	AllowedHeaders: []string{"Accept", "Authorization", "Content-Type"},
}

// noStore keeps every provider response out of shared caches; responses
// carry codes and tokens.
func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("Pragma", "no-cache")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// hashToken is the hex SHA-256 under which codes and refresh tokens are
// stored; the tokens themselves are high-entropy and never stored.
func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// errNotFound marks a missing or expired row; op maps it to the protocol
// error of the endpoint.
var errNotFound = errors.New("oidcprovider: not found")
