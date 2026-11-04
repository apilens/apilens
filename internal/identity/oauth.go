package identity

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/danielgtaylor/huma/v2"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// GoogleIssuer is Google's OIDC issuer; its discovery document supplies the
// authorization and token endpoints and the JWKS.
const GoogleIssuer = "https://accounts.google.com"

// Scopes requested from each provider.
var (
	googleScopes = []string{oidc.ScopeOpenID, "email", "profile"}
	githubScopes = []string{"read:user", "user:email"}
)

// maxNextLen bounds the post-sign-in path carried through the flow.
const maxNextLen = 2048

// discoveryTimeout bounds one OIDC discovery request.
const discoveryTimeout = 10 * time.Second

// OAuthProvider is one configured social sign-in provider. Google is OIDC: its
// endpoints come from discovery, done lazily on first use and cached (a
// failed discovery is retried on the next request), and sign-ins carry a
// nonce. GitHub is plain OAuth2 with fixed endpoints.
type OAuthProvider struct {
	Name   string
	config oauth2.Config // Endpoint is filled by discovery for OIDC providers
	// issuer is the OIDC issuer; empty for plain OAuth2 providers.
	issuer string

	mu   sync.Mutex
	oidc *oidc.Provider
}

// OIDC reports whether the provider is an OIDC provider (signs id_tokens and
// takes a nonce).
func (p *OAuthProvider) OIDC() bool { return p.issuer != "" }

// OAuth2Config returns the provider's OAuth2 client configuration, running
// OIDC discovery first if needed.
func (p *OAuthProvider) OAuth2Config(ctx context.Context) (*oauth2.Config, error) {
	if !p.OIDC() {
		c := p.config
		return &c, nil
	}
	op, err := p.Discover(ctx)
	if err != nil {
		return nil, err
	}
	c := p.config
	c.Endpoint = op.Endpoint()
	return &c, nil
}

// Discover returns the OIDC provider metadata, fetching it once.
func (p *OAuthProvider) Discover(ctx context.Context) (*oidc.Provider, error) {
	if !p.OIDC() {
		return nil, fmt.Errorf("identity: %s is not an OIDC provider", p.Name)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.oidc != nil {
		return p.oidc, nil
	}
	// Discovery outlives a cancelled request: the result is cached for all.
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), discoveryTimeout)
	defer cancel()
	op, err := oidc.NewProvider(dctx, p.issuer)
	if err != nil {
		return nil, fmt.Errorf("identity: %s oidc discovery: %w", p.Name, err)
	}
	p.oidc = op
	return op, nil
}

// OAuthProviders builds the enabled providers from cfg, keyed by name.
func OAuthProviders(cfg config.IdentityConfig) map[string]*OAuthProvider {
	providers := map[string]*OAuthProvider{}
	if g := cfg.OAuth.Google; g.Enabled() {
		providers[config.OAuthProviderGoogle] = &OAuthProvider{
			Name:   config.OAuthProviderGoogle,
			issuer: GoogleIssuer,
			config: oauth2.Config{
				ClientID:     g.ClientID,
				ClientSecret: g.ClientSecret,
				RedirectURL:  cfg.OAuthRedirectURI(config.OAuthProviderGoogle),
				Scopes:       googleScopes,
			},
		}
	}
	if gh := cfg.OAuth.GitHub; gh.Enabled() {
		providers[config.OAuthProviderGitHub] = &OAuthProvider{
			Name: config.OAuthProviderGitHub,
			config: oauth2.Config{
				ClientID:     gh.ClientID,
				ClientSecret: gh.ClientSecret,
				Endpoint:     github.Endpoint,
				RedirectURL:  cfg.OAuthRedirectURI(config.OAuthProviderGitHub),
				Scopes:       githubScopes,
			},
		}
	}
	return providers
}

// OAuth serves the social sign-in endpoints.
type OAuth struct {
	providers map[string]*OAuthProvider
	states    OAuthStateStore
	limiter   *ratelimit.Limiter
	limit     ratelimit.Rate
	logger    *slog.Logger
	// CurrentUser resolves the signed-in user from the request context for
	// intent=link. While nil (no bearer authentication yet), linking is
	// refused as unauthenticated.
	CurrentUser func(context.Context) (userID string, ok bool)
}

// NewOAuth returns the OAuth endpoints for the providers enabled in cfg.
// limiter enforces identity.rate_limits.oauth_start_per_ip on start.
func NewOAuth(cfg config.IdentityConfig, states OAuthStateStore, limiter *ratelimit.Limiter, logger *slog.Logger) *OAuth {
	return &OAuth{
		providers: OAuthProviders(cfg),
		states:    states,
		limiter:   limiter,
		limit:     ratelimit.Rate(cfg.RateLimits.OAuthStartPerIP),
		logger:    logger,
	}
}

// Provider returns the enabled provider name, or nil.
func (o *OAuth) Provider(name string) *OAuthProvider { return o.providers[name] }

// OAuthStartInput is the request of GET /api/v1/auth/oauth/{provider}/start.
type OAuthStartInput struct {
	Provider string `path:"provider" enum:"google,github" doc:"Social sign-in provider."`
	Next     string `query:"next" maxLength:"2048" doc:"Relative path (starting with a single /) to open after sign-in. Defaults to /."`
	Intent   string `query:"intent" enum:"login,link" default:"login" doc:"login signs in or up; link attaches the provider to the signed-in user."`
	Remember bool   `query:"remember" doc:"Keep the session for the long refresh-token lifetime."`
}

// OAuthStartOutput redirects the browser to the provider.
type OAuthStartOutput struct {
	Status   int
	Location string `header:"Location" doc:"The provider's authorization URL."`
}

// Register mounts GET /api/v1/auth/oauth/{provider}/start.
func (o *OAuth) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "start-oauth",
		Method:        http.MethodGet,
		Path:          AuthPrefix + "/oauth/{provider}/start",
		Summary:       "Start social sign-in",
		Description:   "Public browser navigation. Starts an authorization-code flow with PKCE (and an OIDC nonce for Google), keeps the attempt server-side for 10 minutes keyed by a random state, and redirects (302) to the provider. Rate-limited per client IP. A provider that is not configured answers 404.",
		Tags:          []string{server.TagAuth},
		DefaultStatus: http.StatusFound,
		Middlewares:   huma.Middlewares{o.limiter.Limit(api, "oauth_start", o.limit, ratelimit.Key{})},
	}, CodeInvalidRequest, CodeUnauthenticated, CodeRateLimited, CodeInternal), o.start)
}

func (o *OAuth) start(ctx context.Context, in *OAuthStartInput) (*OAuthStartOutput, error) {
	p := o.providers[in.Provider]
	if p == nil {
		return nil, huma.Error404NotFound("provider not enabled")
	}
	next, ok := SafeNext(in.Next)
	if !ok {
		return nil, Err(CodeInvalidRequest)
	}
	st := OAuthState{Provider: p.Name, Next: next, Intent: OAuthIntentLogin, Remember: in.Remember}
	if in.Intent == OAuthIntentLink {
		if o.CurrentUser == nil {
			return nil, Err(CodeUnauthenticated)
		}
		uid, ok := o.CurrentUser(ctx)
		if !ok {
			return nil, Err(CodeUnauthenticated)
		}
		st.Intent, st.LinkUserID = OAuthIntentLink, uid
	}

	cfg, err := p.OAuth2Config(ctx)
	if err != nil {
		o.logger.ErrorContext(ctx, "oauth start: provider unavailable", "provider", p.Name, "error", err)
		return nil, Err(CodeInternal)
	}
	state, err := randomToken()
	if err != nil {
		return nil, Err(CodeInternal)
	}
	st.Verifier = oauth2.GenerateVerifier()
	opts := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(st.Verifier)}
	if p.OIDC() {
		if st.Nonce, err = randomToken(); err != nil {
			return nil, Err(CodeInternal)
		}
		opts = append(opts, oidc.Nonce(st.Nonce))
	}
	if err := o.states.Put(ctx, state, st, OAuthStateTTL); err != nil {
		o.logger.ErrorContext(ctx, "oauth start: store state", "provider", p.Name, "error", err)
		if errors.Is(err, ErrOAuthStateUnavailable) {
			return nil, huma.Error503ServiceUnavailable("sign-in state store unavailable, retry later")
		}
		return nil, Err(CodeInternal)
	}
	return &OAuthStartOutput{Status: http.StatusFound, Location: cfg.AuthCodeURL(state, opts...)}, nil
}

// randomToken returns 32 random bytes, base64url-encoded (256 bits).
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SafeNext validates a post-sign-in redirect target. Only a same-origin
// relative path is accepted: it must start with a single "/" and carry no
// scheme, host, backslash or control character, so it can never send the
// user to another origin ("//evil.com", "/\evil.com", "https://evil.com").
// An empty value means "/".
func SafeNext(next string) (string, bool) {
	if next == "" {
		return "/", true
	}
	if len(next) > maxNextLen || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") {
		return "", false
	}
	for _, r := range next {
		if r < 0x20 || r == 0x7f || r == '\\' {
			return "", false
		}
	}
	u, err := url.Parse(next)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || u.Opaque != "" {
		return "", false
	}
	return next, true
}
