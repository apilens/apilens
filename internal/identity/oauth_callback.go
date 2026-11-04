package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/oauth2"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/server"
)

// providerTimeout bounds each call to a provider (token exchange, JWKS,
// GitHub API) made by the callback.
const providerTimeout = 10 * time.Second

// maxProviderBody bounds a provider API response the callback reads.
const maxProviderBody = 1 << 20

// CodeOAuthDenied is the `?error=` the callback sends the browser back to the
// sign-in page with when the user declined consent at the provider (or the
// provider refused the request). It is a redirect-only code, never the code
// of a problem response.
const CodeOAuthDenied = "oauth_denied"

// ErrOAuthAccountDeleting means the provider identity is linked to an
// account in its deletion grace period, which cannot sign in.
var ErrOAuthAccountDeleting = errors.New("identity: oauth identity belongs to a deleted account")

// ExternalIdentity is a provider account whose email the provider asserted
// as verified.
type ExternalIdentity struct {
	// Provider is config.OAuthProviderGoogle or config.OAuthProviderGitHub.
	Provider string
	// Subject is the provider's stable account id (OIDC sub, GitHub user id).
	Subject string
	// Email is the verified address, normalized (lower case).
	Email string
	// Profile is the rest of the provider profile (name, avatar, login).
	Profile map[string]any
}

// OAuthUsers finds or creates the user of an OAuth sign-in and reads what
// the sign-in needs about them; *PGSignInUsers satisfies it.
type OAuthUsers interface {
	// FindOrCreateOAuth resolves ext to a user: by (provider, subject), else
	// by verified email (linking the identity), else by creating one
	// (users.FindOrCreateByVerifiedEmail with the provider as source).
	// created reports a new user. It returns ErrOAuthAccountDeleting when
	// the linked user is deleted.
	FindOrCreateOAuth(ctx context.Context, ext ExternalIdentity) (user db.User, created bool, err error)
	TOTPConfirmed(ctx context.Context, user uuid.UUID) (bool, error)
	TouchLastLogin(ctx context.Context, user uuid.UUID) error
}

// OAuthSignInDeps are the collaborators of the OAuth callback.
type OAuthSignInDeps struct {
	Users    OAuthUsers
	Sessions SessionCreator
	PreAuth  PreAuthStore
	Handoff  HandoffStore
	Audit    AuditRecorder
	// Identities and Jobs serve intent=link: the provider account is linked
	// to the signed-in user and a security alert is emailed.
	Identities OAuthIdentities
	Jobs       JobEnqueuer
	// SSO refuses addresses whose organization enforces single sign-on
	// (?error=sso_required). Nil checks nothing.
	SSO *SSOEnforcement
}

// OAuthCallbackInput is the request of GET
// /api/v1/auth/oauth/{provider}/callback: what the provider appends to the
// redirect URI.
type OAuthCallbackInput struct {
	Provider string `path:"provider" enum:"google,github" doc:"Social sign-in provider."`
	Code     string `query:"code" maxLength:"2048" doc:"Authorization code from the provider."`
	State    string `query:"state" maxLength:"512" doc:"The state the sign-in was started with."`
	Error    string `query:"error" maxLength:"256" doc:"Set by the provider when the user declined consent or the request failed (RFC 6749 §4.1.2.1)."`
}

// OAuthCallbackOutput redirects the browser to the UI.
type OAuthCallbackOutput struct {
	Status       int
	Location     string `header:"Location" doc:"{public_ui_url}/auth/callback?code=… on success, {public_ui_url}/sign-in?error=<code> on failure."`
	CacheControl string `header:"Cache-Control"`
	Referrer     string `header:"Referrer-Policy"`
}

// callbackFailure is a sign-in that ends on the sign-in page with code.
type callbackFailure struct {
	code   string
	reason string
	err    error
	// intent is the flow's intent, once its state is known.
	intent string
}

func (f *callbackFailure) Error() string {
	if f.err != nil {
		return f.reason + ": " + f.err.Error()
	}
	return f.reason
}

func failure(code ErrCode, reason string, err error) *callbackFailure {
	return &callbackFailure{code: string(code), reason: reason, err: err}
}

func (o *OAuth) registerCallback(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "oauth-callback",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/oauth/{provider}/callback",
		Summary:     "Finish social sign-in",
		Description: "Public browser navigation; the provider redirects here. Takes the sign-in state (single use), exchanges the code with the PKCE verifier and reads a verified email: " +
			"Google from the `id_token` (signature, audience, nonce and `email_verified` checked), GitHub from the primary verified address of `/user/emails`. " +
			"The user is matched by (provider, subject), then by verified email (the identity is linked), else created. " +
			"The session bundle (`amr: [provider]`), or the `2fa_required` answer when the user has two-factor authentication, is kept for 60 seconds under a one-time code " +
			"and the browser is redirected (302) to `{public_ui_url}/auth/callback?code=…`, whose server side redeems it; tokens never appear in a URL. " +
			"Failures redirect to `{public_ui_url}/sign-in?error=<code>`: `oauth_state_mismatch` (unknown, expired, used or foreign state; rejected code or PKCE verifier; wrong nonce), " +
			"`oauth_email_unverified` (no verified email), `oauth_denied` (consent declined), `sso_required` (the email's organization enforces single sign-on), `account_deleting`, `invalid_request` or `internal_error`. " +
			"A flow started with `intent=link` instead connects the provider account to the user who started it (audited as `oauth.linked`, security alert emailed) and redirects to `{public_ui_url}{next}` with `linked={provider}` added; " +
			"a provider account already connected to another user fails with `oauth_identity_taken`. " +
			"A provider that is not configured answers 404.",
		Tags:          []string{server.TagAuth},
		DefaultStatus: http.StatusFound,
	}), o.callback)
}

func (o *OAuth) callback(ctx context.Context, in *OAuthCallbackInput) (*OAuthCallbackOutput, error) {
	p := o.providers[in.Provider]
	if p == nil {
		return nil, huma.Error404NotFound("provider not enabled")
	}
	res, next, err := o.finish(ctx, p, in)
	if err != nil {
		var f *callbackFailure
		if !errors.As(err, &f) {
			f = failure(CodeInternal, "internal", err)
		}
		return o.failRedirect(ctx, p.Name, f), nil
	}
	if res == nil {
		// A linked account: back to where the link was started.
		return o.redirect(next), nil
	}
	code, err := o.signIn.Handoff.Issue(ctx, *res, HandoffTTL)
	if err != nil {
		o.logger.ErrorContext(ctx, "oauth callback: issue handoff code", "provider", p.Name, "error", err)
		return o.redirect("/sign-in?" + url.Values{"error": {string(CodeInternal)}}.Encode()), nil
	}
	return o.redirect("/auth/callback?" + url.Values{"code": {code}}.Encode()), nil
}

// finish runs the callback up to the sign-in answer to hand off, or, for
// intent=link, up to the UI path to return to (with a nil answer).
func (o *OAuth) finish(ctx context.Context, p *OAuthProvider, in *OAuthCallbackInput) (*SignInResponse, string, error) {
	if in.State == "" {
		return nil, "", failure(CodeOAuthStateMismatch, "missing_state", nil)
	}
	// Taking the state burns it whatever happens next.
	st, err := o.states.Take(ctx, in.State)
	switch {
	case errors.Is(err, ErrOAuthStateNotFound):
		return nil, "", failure(CodeOAuthStateMismatch, "unknown_state", nil)
	case err != nil:
		return nil, "", failure(CodeInternal, "load_state", err)
	}
	res, next, err := o.finishState(ctx, p, in, st)
	var f *callbackFailure
	if errors.As(err, &f) {
		f.intent = st.Intent
	}
	return res, next, err
}

// finishState runs the callback of the flow st.
func (o *OAuth) finishState(ctx context.Context, p *OAuthProvider, in *OAuthCallbackInput, st OAuthState) (*SignInResponse, string, error) {
	if st.Provider != p.Name {
		return nil, "", failure(CodeOAuthStateMismatch, "provider_mismatch", nil)
	}
	if in.Error != "" {
		if in.Error == "access_denied" {
			return nil, "", &callbackFailure{code: CodeOAuthDenied, reason: "access_denied"}
		}
		return nil, "", &callbackFailure{code: CodeOAuthDenied, reason: "provider_error", err: errors.New(in.Error)}
	}
	if in.Code == "" {
		return nil, "", failure(CodeInvalidRequest, "missing_code", nil)
	}
	if st.Intent != OAuthIntentLogin && st.Intent != OAuthIntentLink {
		return nil, "", failure(CodeInvalidRequest, "unsupported_intent", nil)
	}

	pctx := context.WithValue(ctx, oauth2.HTTPClient, o.client)
	ext, err := o.identify(pctx, p, st, in.Code)
	if err != nil {
		return nil, "", err
	}
	if st.Intent == OAuthIntentLink {
		next, err := o.linkIdentity(ctx, ext, st)
		return nil, next, err
	}
	res, err := o.signInUser(ctx, ext, st)
	return res, "", err
}

// identify exchanges code and returns the provider account with its verified
// email.
func (o *OAuth) identify(ctx context.Context, p *OAuthProvider, st OAuthState, code string) (ExternalIdentity, error) {
	cfg, err := p.OAuth2Config(ctx)
	if err != nil {
		return ExternalIdentity{}, failure(CodeInternal, "provider_unavailable", err)
	}
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		var re *oauth2.RetrieveError
		if errors.As(err, &re) {
			// The provider refused the code or the PKCE verifier.
			return ExternalIdentity{}, failure(CodeOAuthStateMismatch, "exchange_rejected", err)
		}
		return ExternalIdentity{}, failure(CodeInternal, "exchange", err)
	}
	if p.OIDC() {
		return o.identifyOIDC(ctx, p, st, tok)
	}
	return o.identifyGitHub(ctx, p, cfg, tok)
}

// googleClaims are the id_token claims the sign-in reads.
type googleClaims struct {
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

// identifyOIDC verifies the id_token (signature, issuer, audience, expiry and
// nonce) and reads its verified email.
func (o *OAuth) identifyOIDC(ctx context.Context, p *OAuthProvider, st OAuthState, tok *oauth2.Token) (ExternalIdentity, error) {
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return ExternalIdentity{}, failure(CodeOAuthStateMismatch, "missing_id_token", nil)
	}
	op, err := p.Discover(ctx)
	if err != nil {
		return ExternalIdentity{}, failure(CodeInternal, "provider_unavailable", err)
	}
	idt, err := op.Verifier(&oidc.Config{ClientID: p.config.ClientID}).Verify(ctx, raw)
	if err != nil {
		return ExternalIdentity{}, failure(CodeOAuthStateMismatch, "invalid_id_token", err)
	}
	if st.Nonce == "" || idt.Nonce != st.Nonce {
		return ExternalIdentity{}, failure(CodeOAuthStateMismatch, "nonce_mismatch", nil)
	}
	var c googleClaims
	if err := idt.Claims(&c); err != nil {
		return ExternalIdentity{}, failure(CodeOAuthStateMismatch, "invalid_id_token", err)
	}
	if !c.EmailVerified {
		return ExternalIdentity{}, failure(CodeOAuthEmailUnverified, "email_unverified", nil)
	}
	addr, ok := NormalizeEmail(c.Email)
	if !ok {
		return ExternalIdentity{}, failure(CodeOAuthEmailUnverified, "invalid_email", nil)
	}
	return ExternalIdentity{
		Provider: p.Name,
		Subject:  idt.Subject,
		Email:    addr,
		Profile:  map[string]any{"name": c.Name, "picture": c.Picture},
	}, nil
}

// githubUser is the part of GET /user the sign-in reads.
type githubUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// githubEmail is one entry of GET /user/emails.
type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// identifyGitHub reads the account (GET /user) and its primary verified
// address (GET /user/emails).
func (o *OAuth) identifyGitHub(ctx context.Context, p *OAuthProvider, cfg *oauth2.Config, tok *oauth2.Token) (ExternalIdentity, error) {
	client := cfg.Client(ctx, tok)
	var u githubUser
	if err := githubGet(ctx, client, p.apiURL+"/user", &u); err != nil {
		return ExternalIdentity{}, failure(CodeInternal, "github_user", err)
	}
	if u.ID <= 0 {
		return ExternalIdentity{}, failure(CodeInternal, "github_user", errors.New("no user id"))
	}
	var emails []githubEmail
	if err := githubGet(ctx, client, p.apiURL+"/user/emails", &emails); err != nil {
		return ExternalIdentity{}, failure(CodeInternal, "github_emails", err)
	}
	var addr string
	for _, e := range emails {
		if e.Primary && e.Verified {
			a, ok := NormalizeEmail(e.Email)
			if ok {
				addr = a
			}
			break
		}
	}
	if addr == "" {
		return ExternalIdentity{}, failure(CodeOAuthEmailUnverified, "email_unverified", nil)
	}
	return ExternalIdentity{
		Provider: p.Name,
		Subject:  strconv.FormatInt(u.ID, 10),
		Email:    addr,
		Profile:  map[string]any{"login": u.Login, "name": u.Name, "avatar_url": u.AvatarURL},
	}, nil
}

// githubGet GETs a GitHub API resource into v.
func githubGet(ctx context.Context, client *http.Client, u string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d", u, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxProviderBody)).Decode(v)
}

// signInUser resolves ext to a user and answers the session bundle or
// 2fa_required, as the email sign-in does.
func (o *OAuth) signInUser(ctx context.Context, ext ExternalIdentity, st OAuthState) (*SignInResponse, error) {
	d := o.signIn
	if d.Users == nil || d.Sessions == nil || d.PreAuth == nil || d.Handoff == nil || d.Audit == nil {
		return nil, failure(CodeInternal, "not_configured", errors.New("oauth sign-in collaborators not set"))
	}
	_, ssoRequired, err := d.SSO.Required(ctx, ext.Email)
	if err != nil {
		return nil, failure(CodeInternal, "sso_enforcement", err)
	}
	if ssoRequired {
		return nil, failure(CodeSSORequired, "sso_required", nil)
	}
	user, created, err := d.Users.FindOrCreateOAuth(ctx, ext)
	switch {
	case errors.Is(err, ErrOAuthAccountDeleting):
		return nil, failure(CodeAccountDeleting, "account_deleting", nil)
	case err != nil:
		return nil, failure(CodeInternal, "find_or_create_user", err)
	}
	next := st.Next
	// A new user starts onboarding unless the sign-in asked to go elsewhere.
	if created && (next == "" || next == "/") {
		next = users.OnboardingPath
	}
	amr := []string{ext.Provider}

	twoFactor, err := d.Users.TOTPConfirmed(ctx, user.ID)
	if err != nil {
		return nil, failure(CodeInternal, "load_two_factor", err)
	}
	if twoFactor {
		pre, err := d.PreAuth.Issue(ctx, PreAuth{UserID: user.ID, AMR: amr, Remember: st.Remember, Next: next}, o.preAuthTTL)
		if err != nil {
			return nil, failure(CodeInternal, "issue_pre_auth", err)
		}
		res := NewSignInTwoFactor(pre, next)
		return &res, nil
	}

	t, err := d.Sessions.Create(ctx, user, st.Remember, session.Meta{AMR: amr})
	if err != nil {
		return nil, failure(CodeInternal, "create_session", err)
	}
	// The session exists: bookkeeping failures below are logged, not
	// returned.
	if err := d.Users.TouchLastLogin(ctx, user.ID); err != nil {
		o.logger.ErrorContext(ctx, "oauth callback: touch last login", "error", err, "user_id", user.ID)
	}
	if err := d.Audit.Record(ctx, audit.Event{
		User:  &user.ID,
		Actor: &user.ID,
		Kind:  audit.LoginSucceeded,
		Meta: map[string]any{
			"method":     ext.Provider,
			"amr":        amr,
			"session_id": t.Session.ID.String(),
			"remember":   st.Remember,
		},
	}); err != nil {
		o.logger.ErrorContext(ctx, "oauth callback: audit", "error", err, "user_id", user.ID)
	}
	res := NewSignInSession(t, next, o.now())
	return &res, nil
}

// failRedirect logs and audits a failed callback and sends the browser to
// the sign-in page with the failure's code.
func (o *OAuth) failRedirect(ctx context.Context, provider string, f *callbackFailure) *OAuthCallbackOutput {
	if f.code == string(CodeInternal) {
		o.logger.ErrorContext(ctx, "oauth callback failed", "provider", provider, "reason", f.reason, "error", f.err)
	} else {
		o.logger.InfoContext(ctx, "oauth callback rejected", "provider", provider, "reason", f.reason, "error", f.err)
	}
	if o.signIn.Audit != nil {
		meta := map[string]any{"method": provider, "reason": f.reason, "code": f.code}
		if f.intent == OAuthIntentLink {
			meta["intent"] = f.intent
		}
		if err := o.signIn.Audit.Record(ctx, audit.Event{
			Kind: audit.LoginFailed,
			Meta: meta,
		}); err != nil {
			o.logger.ErrorContext(ctx, "oauth callback: audit", "error", err)
		}
	}
	return o.redirect("/sign-in?" + url.Values{"error": {f.code}}.Encode())
}

// redirect answers a 302 to path on the UI.
func (o *OAuth) redirect(path string) *OAuthCallbackOutput {
	return &OAuthCallbackOutput{
		Status:       http.StatusFound,
		Location:     o.uiURL + path,
		CacheControl: "no-store",
		// The handoff code rides in the URL: keep it out of Referer headers.
		Referrer: "no-referrer",
	}
}

// FindOrCreateOAuth implements OAuthUsers.
func (s *PGSignInUsers) FindOrCreateOAuth(ctx context.Context, ext ExternalIdentity) (db.User, bool, error) {
	source := users.Source(ext.Provider)
	if !source.Valid() || source == users.SourceEmail || source == users.SourceSSO || source == users.SourceOperator {
		return db.User{}, false, fmt.Errorf("identity: unknown oauth provider %q", ext.Provider)
	}
	profile, err := json.Marshal(ext.Profile)
	if err != nil {
		return db.User{}, false, fmt.Errorf("identity: encode oauth profile: %w", err)
	}
	email := strings.ToLower(ext.Email)
	for attempt := 0; ; attempt++ {
		linked, err := s.q.GetOAuthIdentityByProviderSubject(ctx, db.GetOAuthIdentityByProviderSubjectParams{Provider: ext.Provider, Subject: ext.Subject})
		switch {
		case err == nil:
			user, err := s.q.GetUserByID(ctx, linked.UserID)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				return db.User{}, false, ErrOAuthAccountDeleting
			case err != nil:
				return db.User{}, false, fmt.Errorf("identity: load oauth user: %w", err)
			}
			if err := s.q.TouchOAuthIdentityLogin(ctx, db.TouchOAuthIdentityLoginParams{ID: linked.ID, Email: &email, Profile: profile}); err != nil {
				return db.User{}, false, fmt.Errorf("identity: touch oauth identity: %w", err)
			}
			return user, false, nil
		case !errors.Is(err, pgx.ErrNoRows):
			return db.User{}, false, fmt.Errorf("identity: look up oauth identity: %w", err)
		}

		user, created, err := s.users.FindOrCreateByVerifiedEmail(ctx, email, source)
		if err != nil {
			return db.User{}, false, err
		}
		now := time.Now()
		_, err = s.q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
			ID:          uuid.New(),
			UserID:      user.ID,
			Provider:    ext.Provider,
			Subject:     ext.Subject,
			Email:       &email,
			Profile:     profile,
			LastLoginAt: &now,
		})
		var pgErr *pgconn.PgError
		if err != nil && attempt == 0 && errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// A concurrent callback linked the identity first: resolve it.
			continue
		}
		if err != nil {
			return db.User{}, false, fmt.Errorf("identity: link oauth identity: %w", err)
		}
		return user, created, nil
	}
}
