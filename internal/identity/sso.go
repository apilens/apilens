package identity

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"

	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// SSOProvider is the OAuthState.Provider of an organization SSO sign-in. It
// is never a social provider name, so a state started for one flow is refused
// by the other's callback.
const SSOProvider = "sso"

// ssoScopes are requested from an organization's identity provider.
var ssoScopes = []string{oidc.ScopeOpenID, "email", "profile"}

// maxSSOIssuers bounds the cache of discovered identity providers.
const maxSSOIssuers = 256

// SSOClientSecretAD is the additional data an organization's sealed client
// secret (org_sso_connections.client_secret_enc) is bound to, so a
// ciphertext copied onto another organization's row fails to open.
func SSOClientSecretAD(org uuid.UUID) []byte {
	return []byte("org_sso_connections:" + org.String())
}

// SealSSOClientSecret encrypts org's OIDC client secret for
// org_sso_connections.client_secret_enc.
func SealSSOClientSecret(sealer *idkeys.Sealer, org uuid.UUID, secret string) ([]byte, error) {
	b, err := sealer.Seal([]byte(secret), SSOClientSecretAD(org))
	if err != nil {
		return nil, fmt.Errorf("identity: seal sso client secret: %w", err)
	}
	return b, nil
}

// OpenSSOClientSecret decrypts org's stored OIDC client secret.
func OpenSSOClientSecret(sealer *idkeys.Sealer, org uuid.UUID, sealed []byte) (string, error) {
	b, err := sealer.Open(sealed, SSOClientSecretAD(org))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// SSOStore reads organizations' SSO connections; *db.Queries satisfies it.
type SSOStore interface {
	GetOrgSSOConnectionBySlug(ctx context.Context, slug string) (db.GetOrgSSOConnectionBySlugRow, error)
	TouchOrgSSOLastLogin(ctx context.Context, orgID uuid.UUID) error
}

// SSOUsers finds or creates the user of an SSO sign-in and reads what the
// sign-in needs about them; *PGSignInUsers satisfies it.
type SSOUsers interface {
	// FindOrCreateSSO returns the active user with address email, marking
	// it verified, or creates one (users.FindOrCreateByVerifiedEmail with
	// source sso). created reports a new user.
	FindOrCreateSSO(ctx context.Context, email string) (user db.User, created bool, err error)
	TOTPConfirmed(ctx context.Context, user uuid.UUID) (bool, error)
	TouchLastLogin(ctx context.Context, user uuid.UUID) error
}

// SSOMemberships adds the user of an SSO sign-in to the organization;
// *orgs.Service of the control plane satisfies it.
type SSOMemberships interface {
	// JoinViaSSO makes user a member of org with role unless they already
	// are one, emitting the membership outbox row with it. joined reports
	// whether a membership was created.
	JoinViaSSO(ctx context.Context, org, user uuid.UUID, role string) (joined bool, err error)
}

// SSODeps are the collaborators of the SSO endpoints.
type SSODeps struct {
	Connections SSOStore
	// Sealer opens the connections' client secrets (the identity
	// key-encryption key).
	Sealer      *idkeys.Sealer
	Users       SSOUsers
	Memberships SSOMemberships
	Sessions    SessionCreator
	PreAuth     PreAuthStore
	Handoff     HandoffStore
	Audit       AuditRecorder
}

// SSO serves the organization single sign-on endpoints: GET
// /api/v1/auth/sso/{org}/start and …/callback. It is the social sign-in
// flow (state, PKCE, nonce, handoff code) against the OIDC identity provider
// of the organization's connection.
type SSO struct {
	deps       SSODeps
	states     OAuthStateStore
	limiter    *ratelimit.Limiter
	limit      ratelimit.Rate
	logger     *slog.Logger
	issuer     string
	uiURL      string
	preAuthTTL time.Duration
	client     *http.Client
	now        func() time.Time

	mu        sync.Mutex
	providers map[string]*oidc.Provider // discovered, by issuer
}

// NewSSO returns the SSO endpoints. limiter enforces
// identity.rate_limits.oauth_start_per_ip on start.
func NewSSO(cfg config.IdentityConfig, states OAuthStateStore, deps SSODeps, limiter *ratelimit.Limiter, logger *slog.Logger) *SSO {
	ttl := cfg.PreAuthTTL
	if ttl <= 0 {
		ttl = defaultPreAuthTTL
	}
	return &SSO{
		deps:       deps,
		states:     states,
		limiter:    limiter,
		limit:      ratelimit.Rate(cfg.RateLimits.OAuthStartPerIP),
		logger:     logger,
		issuer:     strings.TrimRight(cfg.Issuer, "/"),
		uiURL:      strings.TrimRight(cfg.PublicUIURL, "/"),
		preAuthTTL: ttl,
		client:     &http.Client{Timeout: providerTimeout},
		now:        time.Now,
		providers:  map[string]*oidc.Provider{},
	}
}

// SSOStartURL is the start of the SSO sign-in of organization slug under the
// identity issuer URL.
func SSOStartURL(issuer, slug string) string {
	return strings.TrimRight(issuer, "/") + AuthPrefix + "/sso/" + url.PathEscape(slug) + "/start"
}

// redirectURI is the callback registered with the organization's provider.
func (s *SSO) redirectURI(slug string) string {
	return s.issuer + AuthPrefix + "/sso/" + url.PathEscape(slug) + "/callback"
}

// SSOStartInput is the request of GET /api/v1/auth/sso/{org}/start.
type SSOStartInput struct {
	Org       string `path:"org" maxLength:"63" doc:"Organization slug."`
	Next      string `query:"next" maxLength:"2048" doc:"Relative path (starting with a single /) to open after sign-in. Defaults to /."`
	Remember  bool   `query:"remember" doc:"Keep the session for the long refresh-token lifetime."`
	LoginHint string `query:"login_hint" maxLength:"254" doc:"Email typed on the sign-in page, passed to the identity provider as login_hint."`
}

// SSOCallbackInput is the request of GET /api/v1/auth/sso/{org}/callback.
type SSOCallbackInput struct {
	Org   string `path:"org" maxLength:"63" doc:"Organization slug."`
	Code  string `query:"code" maxLength:"2048" doc:"Authorization code from the identity provider."`
	State string `query:"state" maxLength:"512" doc:"The state the sign-in was started with."`
	Error string `query:"error" maxLength:"256" doc:"Set by the identity provider when the user declined or the request failed (RFC 6749 §4.1.2.1)."`
}

// Register mounts GET /api/v1/auth/sso/{org}/start and …/callback.
func (s *SSO) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "start-sso",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/sso/{org}/start",
		Summary:     "Start organization single sign-on",
		Description: "Public browser navigation; `start_url` of the SSO lookup points here. Starts an authorization-code flow with PKCE and an OIDC nonce against the identity provider of the organization's connection " +
			"(endpoints from its OIDC discovery), keeps the attempt server-side for 10 minutes keyed by a random state, and redirects (302) to the provider. " +
			"Rate-limited per client IP. An organization that does not exist or has no SSO connection answers 404.",
		Tags:          []string{server.TagAuth},
		DefaultStatus: http.StatusFound,
		Middlewares:   huma.Middlewares{s.limiter.Limit(api, "sso_start", s.limit, ratelimit.Key{})},
	}, CodeInvalidRequest, CodeRateLimited, CodeInternal), s.start)
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "sso-callback",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/sso/{org}/callback",
		Summary:     "Finish organization single sign-on",
		Description: "Public browser navigation; the organization's identity provider redirects here. Takes the sign-in state (single use), exchanges the code with the PKCE verifier and verifies the `id_token` " +
			"(signature, issuer, audience, expiry, nonce). Its `email` must be at one of the connection's domains (an `email_verified: false` claim is refused). " +
			"The user is found by email or created, and joins the organization with the connection's `default_role` if not yet a member. " +
			"The session bundle (`amr: [\"sso\"]`), or the `2fa_required` answer, is kept for 60 seconds under a one-time code and the browser is redirected (302) to `{public_ui_url}/auth/callback?code=…`. " +
			"Failures redirect to `{public_ui_url}/sign-in?error=<code>`: `oauth_state_mismatch`, `oauth_email_unverified`, `oauth_denied`, `forbidden` (email outside the connection's domains), `invalid_request` or `internal_error`. " +
			"An organization that does not exist or has no SSO connection answers 404.",
		Tags:          []string{server.TagAuth},
		DefaultStatus: http.StatusFound,
	}), s.callback)
}

// connection loads the SSO connection of organization slug, or answers 404.
func (s *SSO) connection(ctx context.Context, slug string) (db.GetOrgSSOConnectionBySlugRow, error) {
	if s.deps.Connections == nil {
		return db.GetOrgSSOConnectionBySlugRow{}, Err(CodeInternal)
	}
	conn, err := s.deps.Connections.GetOrgSSOConnectionBySlug(ctx, slug)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return conn, huma.Error404NotFound("single sign-on is not configured for this organization")
	case err != nil:
		s.logger.ErrorContext(ctx, "sso: load connection", "org", slug, "error", err)
		return conn, Err(CodeInternal)
	}
	return conn, nil
}

// discover returns the OIDC metadata of issuer, fetching it once. A failed
// discovery is not cached, so it is retried on the next request.
func (s *SSO) discover(ctx context.Context, issuer string) (*oidc.Provider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if op := s.providers[issuer]; op != nil {
		return op, nil
	}
	// Discovery outlives a cancelled request: the result is cached for all.
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), discoveryTimeout)
	defer cancel()
	op, err := oidc.NewProvider(oidc.ClientContext(dctx, s.client), issuer)
	if err != nil {
		return nil, fmt.Errorf("identity: sso oidc discovery: %w", err)
	}
	if len(s.providers) >= maxSSOIssuers {
		clear(s.providers)
	}
	s.providers[issuer] = op
	return op, nil
}

func (s *SSO) start(ctx context.Context, in *SSOStartInput) (*OAuthStartOutput, error) {
	conn, err := s.connection(ctx, in.Org)
	if err != nil {
		return nil, err
	}
	next, ok := SafeNext(in.Next)
	if !ok {
		return nil, Err(CodeInvalidRequest)
	}
	op, err := s.discover(ctx, conn.Issuer)
	if err != nil {
		s.logger.ErrorContext(ctx, "sso start: provider unavailable", "org", conn.Slug, "error", err)
		return nil, Err(CodeInternal)
	}
	state, err := randomToken()
	if err != nil {
		return nil, Err(CodeInternal)
	}
	st := OAuthState{
		Provider: SSOProvider,
		OrgID:    conn.OrgID.String(),
		Next:     next,
		Intent:   OAuthIntentLogin,
		Remember: in.Remember,
		Verifier: oauth2.GenerateVerifier(),
	}
	if st.Nonce, err = randomToken(); err != nil {
		return nil, Err(CodeInternal)
	}
	opts := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(st.Verifier), oidc.Nonce(st.Nonce)}
	if hint, ok := NormalizeEmail(in.LoginHint); ok {
		opts = append(opts, oauth2.SetAuthURLParam("login_hint", hint))
	}
	if err := s.states.Put(ctx, state, st, OAuthStateTTL); err != nil {
		s.logger.ErrorContext(ctx, "sso start: store state", "org", conn.Slug, "error", err)
		if errors.Is(err, ErrOAuthStateUnavailable) {
			return nil, huma.Error503ServiceUnavailable("sign-in state store unavailable, retry later")
		}
		return nil, Err(CodeInternal)
	}
	cfg := oauth2.Config{ClientID: conn.ClientID, Endpoint: op.Endpoint(), RedirectURL: s.redirectURI(conn.Slug), Scopes: ssoScopes}
	return &OAuthStartOutput{Status: http.StatusFound, Location: cfg.AuthCodeURL(state, opts...)}, nil
}

func (s *SSO) callback(ctx context.Context, in *SSOCallbackInput) (*OAuthCallbackOutput, error) {
	conn, err := s.connection(ctx, in.Org)
	if err != nil {
		return nil, err
	}
	res, err := s.finish(ctx, conn, in)
	if err != nil {
		var f *callbackFailure
		if !errors.As(err, &f) {
			f = failure(CodeInternal, "internal", err)
		}
		return s.failRedirect(ctx, conn, f), nil
	}
	code, err := s.deps.Handoff.Issue(ctx, *res, HandoffTTL)
	if err != nil {
		s.logger.ErrorContext(ctx, "sso callback: issue handoff code", "org", conn.Slug, "error", err)
		return s.redirect("/sign-in?" + url.Values{"error": {string(CodeInternal)}}.Encode()), nil
	}
	return s.redirect("/auth/callback?" + url.Values{"code": {code}}.Encode()), nil
}

// ssoClaims are the id_token claims the SSO sign-in reads.
type ssoClaims struct {
	Email string `json:"email"`
	// EmailVerified is optional: many enterprise providers never send it.
	// The connection's domains vouch for the address; an explicit false is
	// refused.
	EmailVerified *bool  `json:"email_verified"`
	Name          string `json:"name"`
}

// finish runs the callback up to the sign-in answer to hand off.
func (s *SSO) finish(ctx context.Context, conn db.GetOrgSSOConnectionBySlugRow, in *SSOCallbackInput) (*SignInResponse, error) {
	if in.State == "" {
		return nil, failure(CodeOAuthStateMismatch, "missing_state", nil)
	}
	// Taking the state burns it whatever happens next.
	st, err := s.states.Take(ctx, in.State)
	switch {
	case errors.Is(err, ErrOAuthStateNotFound):
		return nil, failure(CodeOAuthStateMismatch, "unknown_state", nil)
	case err != nil:
		return nil, failure(CodeInternal, "load_state", err)
	}
	if st.Provider != SSOProvider || st.OrgID != conn.OrgID.String() {
		return nil, failure(CodeOAuthStateMismatch, "org_mismatch", nil)
	}
	if in.Error != "" {
		if in.Error == "access_denied" {
			return nil, &callbackFailure{code: CodeOAuthDenied, reason: "access_denied"}
		}
		return nil, &callbackFailure{code: CodeOAuthDenied, reason: "provider_error", err: errors.New(in.Error)}
	}
	if in.Code == "" {
		return nil, failure(CodeInvalidRequest, "missing_code", nil)
	}
	if st.Intent != OAuthIntentLogin {
		return nil, failure(CodeInvalidRequest, "unsupported_intent", nil)
	}
	email, err := s.identify(ctx, conn, st, in.Code)
	if err != nil {
		return nil, err
	}
	return s.signInUser(ctx, conn, email, st)
}

// identify exchanges code, verifies the id_token and returns its email,
// which must be at one of the connection's domains.
func (s *SSO) identify(ctx context.Context, conn db.GetOrgSSOConnectionBySlugRow, st OAuthState, code string) (string, error) {
	if s.deps.Sealer == nil {
		return "", failure(CodeInternal, "not_configured", errors.New("sso sealer not set"))
	}
	secret, err := OpenSSOClientSecret(s.deps.Sealer, conn.OrgID, conn.ClientSecretEnc)
	if err != nil {
		return "", failure(CodeInternal, "open_client_secret", err)
	}
	op, err := s.discover(ctx, conn.Issuer)
	if err != nil {
		return "", failure(CodeInternal, "provider_unavailable", err)
	}
	cfg := oauth2.Config{
		ClientID:     conn.ClientID,
		ClientSecret: secret,
		Endpoint:     op.Endpoint(),
		RedirectURL:  s.redirectURI(conn.Slug),
		Scopes:       ssoScopes,
	}
	pctx := context.WithValue(ctx, oauth2.HTTPClient, s.client)
	tok, err := cfg.Exchange(pctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		var re *oauth2.RetrieveError
		if errors.As(err, &re) {
			return "", failure(CodeOAuthStateMismatch, "exchange_rejected", err)
		}
		return "", failure(CodeInternal, "exchange", err)
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return "", failure(CodeOAuthStateMismatch, "missing_id_token", nil)
	}
	idt, err := op.Verifier(&oidc.Config{ClientID: conn.ClientID}).Verify(pctx, raw)
	if err != nil {
		return "", failure(CodeOAuthStateMismatch, "invalid_id_token", err)
	}
	if st.Nonce == "" || idt.Nonce != st.Nonce {
		return "", failure(CodeOAuthStateMismatch, "nonce_mismatch", nil)
	}
	var c ssoClaims
	if err := idt.Claims(&c); err != nil {
		return "", failure(CodeOAuthStateMismatch, "invalid_id_token", err)
	}
	if c.EmailVerified != nil && !*c.EmailVerified {
		return "", failure(CodeOAuthEmailUnverified, "email_unverified", nil)
	}
	addr, ok := NormalizeEmail(c.Email)
	if !ok {
		return "", failure(CodeOAuthEmailUnverified, "invalid_email", nil)
	}
	// The connection may only vouch for addresses at its own domains, never
	// at a public mailbox provider: otherwise an organization's provider
	// could sign in as any account.
	domain := addr[strings.LastIndexByte(addr, '@')+1:]
	if IsPublicEmailDomain(domain) || !slices.Contains(conn.Domains, domain) {
		return "", failure(CodeForbidden, "email_domain_not_allowed", nil)
	}
	return addr, nil
}

// signInUser finds or creates the user, adds them to the organization and
// answers the session bundle or 2fa_required.
func (s *SSO) signInUser(ctx context.Context, conn db.GetOrgSSOConnectionBySlugRow, email string, st OAuthState) (*SignInResponse, error) {
	d := s.deps
	if d.Users == nil || d.Memberships == nil || d.Sessions == nil || d.PreAuth == nil || d.Handoff == nil || d.Audit == nil {
		return nil, failure(CodeInternal, "not_configured", errors.New("sso sign-in collaborators not set"))
	}
	user, created, err := d.Users.FindOrCreateSSO(ctx, email)
	if err != nil {
		return nil, failure(CodeInternal, "find_or_create_user", err)
	}
	// Just-in-time membership: the provider vouched for an address at the
	// organization's domain.
	joined, err := d.Memberships.JoinViaSSO(ctx, conn.OrgID, user.ID, conn.DefaultRole)
	if err != nil {
		return nil, failure(CodeInternal, "join_org", err)
	}
	next := st.Next
	if created && (next == "" || next == "/") {
		next = users.OnboardingPath
	}
	amr := []string{token.AMRSSO}

	twoFactor, err := d.Users.TOTPConfirmed(ctx, user.ID)
	if err != nil {
		return nil, failure(CodeInternal, "load_two_factor", err)
	}
	if twoFactor {
		pre, err := d.PreAuth.Issue(ctx, PreAuth{UserID: user.ID, AMR: amr, Remember: st.Remember, Next: next}, s.preAuthTTL)
		if err != nil {
			return nil, failure(CodeInternal, "issue_pre_auth", err)
		}
		s.touchConnection(ctx, conn)
		res := NewSignInTwoFactor(pre, next)
		return &res, nil
	}

	t, err := d.Sessions.Create(ctx, user, st.Remember, session.Meta{AMR: amr})
	if err != nil {
		return nil, failure(CodeInternal, "create_session", err)
	}
	// The session exists: bookkeeping failures below are logged, not
	// returned.
	s.touchConnection(ctx, conn)
	if err := d.Users.TouchLastLogin(ctx, user.ID); err != nil {
		s.logger.ErrorContext(ctx, "sso callback: touch last login", "error", err, "user_id", user.ID)
	}
	if err := d.Audit.Record(ctx, audit.Event{
		User:  &user.ID,
		Actor: &user.ID,
		Kind:  audit.LoginSucceeded,
		Meta: map[string]any{
			"method":     SSOProvider,
			"amr":        amr,
			"session_id": t.Session.ID.String(),
			"remember":   st.Remember,
			"org_id":     conn.OrgID.String(),
			"joined":     joined,
		},
	}); err != nil {
		s.logger.ErrorContext(ctx, "sso callback: audit", "error", err, "user_id", user.ID)
	}
	res := NewSignInSession(t, next, s.now())
	return &res, nil
}

// touchConnection records the sign-in on the connection; a failure is
// logged only.
func (s *SSO) touchConnection(ctx context.Context, conn db.GetOrgSSOConnectionBySlugRow) {
	if err := s.deps.Connections.TouchOrgSSOLastLogin(ctx, conn.OrgID); err != nil {
		s.logger.ErrorContext(ctx, "sso callback: touch connection", "error", err, "org_id", conn.OrgID)
	}
}

// failRedirect logs and audits a failed callback and sends the browser to
// the sign-in page with the failure's code.
func (s *SSO) failRedirect(ctx context.Context, conn db.GetOrgSSOConnectionBySlugRow, f *callbackFailure) *OAuthCallbackOutput {
	if f.code == string(CodeInternal) {
		s.logger.ErrorContext(ctx, "sso callback failed", "org", conn.Slug, "reason", f.reason, "error", f.err)
	} else {
		s.logger.InfoContext(ctx, "sso callback rejected", "org", conn.Slug, "reason", f.reason, "error", f.err)
	}
	if s.deps.Audit != nil {
		if err := s.deps.Audit.Record(ctx, audit.Event{
			Kind: audit.LoginFailed,
			Meta: map[string]any{"method": SSOProvider, "org_id": conn.OrgID.String(), "reason": f.reason, "code": f.code},
		}); err != nil {
			s.logger.ErrorContext(ctx, "sso callback: audit", "error", err)
		}
	}
	return s.redirect("/sign-in?" + url.Values{"error": {f.code}}.Encode())
}

// redirect answers a 302 to path on the UI.
func (s *SSO) redirect(path string) *OAuthCallbackOutput {
	return &OAuthCallbackOutput{
		Status:       http.StatusFound,
		Location:     s.uiURL + path,
		CacheControl: "no-store",
		Referrer:     "no-referrer",
	}
}

// FindOrCreateSSO implements SSOUsers.
func (s *PGSignInUsers) FindOrCreateSSO(ctx context.Context, email string) (db.User, bool, error) {
	return s.users.FindOrCreateByVerifiedEmail(ctx, email, users.SourceSSO)
}

// SSOEnforcement tells the email and social sign-ins whether an address must
// sign in through its organization's SSO.
type SSOEnforcement struct {
	store  SSOLookupStore
	issuer string
}

// NewSSOEnforcement returns the check over store; issuer is the identity
// issuer URL the SSO start URLs are under.
func NewSSOEnforcement(store SSOLookupStore, issuer string) *SSOEnforcement {
	return &SSOEnforcement{store: store, issuer: issuer}
}

// Required reports whether addr (normalized) is at a domain whose
// organization enforces SSO, and if so that organization's SSO start URL.
// Public mailbox domains are never enforced.
func (e *SSOEnforcement) Required(ctx context.Context, addr string) (startURL string, required bool, err error) {
	if e == nil || e.store == nil {
		return "", false, nil
	}
	domain := addr[strings.LastIndexByte(addr, '@')+1:]
	if IsPublicEmailDomain(domain) {
		return "", false, nil
	}
	row, err := e.store.LookupOrgSSOForDomain(ctx, domain)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return "", false, nil
	case err != nil:
		return "", false, fmt.Errorf("identity: sso enforcement: %w", err)
	}
	if !row.Enforce {
		return "", false, nil
	}
	return SSOStartURL(e.issuer, row.Slug), true, nil
}
