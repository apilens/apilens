package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// ReauthPrefix is the path prefix of re-authentication: a signed-in user
// confirms who they are again, without signing out, before a sensitive
// action that answered reauth_required.
const ReauthPrefix = AuthPrefix + "/reauth"

// Re-authentication methods, as listed by the options endpoint and chosen in
// the verify request.
const (
	ReauthPasskey = "passkey"
	ReauthTOTP    = "totp"
	ReauthEmail   = "email"
	// ReauthSSO is never verified here: the user goes through their
	// organization's identity provider (sso_url).
	ReauthSSO = "sso"
)

// ReauthSessions moves a session's authentication time forward;
// *session.Service satisfies it.
type ReauthSessions interface {
	Reauthenticate(ctx context.Context, user, sid uuid.UUID) (session.Reauthenticated, error)
}

// ReauthUsers reads what re-authentication needs about a user; *db.Queries
// satisfies it.
type ReauthUsers interface {
	GetUserByID(ctx context.Context, id uuid.UUID) (db.User, error)
	CountPasskeyCredentialsForUser(ctx context.Context, userID uuid.UUID) (int64, error)
	GetTOTPForUser(ctx context.Context, userID uuid.UUID) (db.UserTotp, error)
}

// ReauthCodes issues and checks the emailed code; *emailauth.Service
// satisfies it.
type ReauthCodes interface {
	Issue(ctx context.Context, email string, intent emailauth.Intent, opts emailauth.IssueOptions) (emailauth.Issued, error)
	Latest(ctx context.Context, email string) (db.AuthEmailToken, bool, error)
	VerifyCode(ctx context.Context, email, code string) (db.AuthEmailToken, error)
}

// ReauthTwoFactor checks a code from the authenticator app; *twofactor.Service
// satisfies it.
type ReauthTwoFactor interface {
	SignIn(ctx context.Context, user uuid.UUID, p twofactor.Proof) (db.User, string, error)
}

// ReauthDeps are the collaborators of the re-authentication endpoints.
type ReauthDeps struct {
	Users     ReauthUsers
	Sessions  ReauthSessions
	Passkeys  PasskeyAuthenticator
	TwoFactor ReauthTwoFactor
	Codes     ReauthCodes
	Jobs      JobEnqueuer
	Audit     AuditRecorder
	// SSO sends users whose organization enforces single sign-on through
	// its identity provider. Nil checks nothing.
	SSO *SSOEnforcement
}

// ReauthOptionsBody is the optional request body of POST
// /api/v1/auth/reauth/options.
type ReauthOptionsBody struct {
	SendEmailCode bool   `json:"send_email_code,omitempty" doc:"Email a 6-digit code to the user's address now (only when email is among the methods). Within 30 seconds of the previous code no new email is sent; retry_after is the remaining wait."`
	Next          string `json:"next,omitempty" maxLength:"512" doc:"Relative path (starting with a single /) to return to after an SSO re-authentication; put into sso_url."`
}

// ReauthOptionsInput is the request of POST /api/v1/auth/reauth/options.
type ReauthOptionsInput struct {
	Body *ReauthOptionsBody
}

// ReauthPasskeyOptions starts the passkey ceremony of a re-authentication.
type ReauthPasskeyOptions struct {
	ChallengeID string          `json:"challenge_id" doc:"Send back with the verify request. Valid for 5 minutes, once."`
	Options     json.RawMessage `json:"options" doc:"CredentialRequestOptions ({publicKey: ...}) for navigator.credentials.get(), limited to the user's passkeys."`
}

// ReauthOptionsResponse is the body of POST /api/v1/auth/reauth/options.
type ReauthOptionsResponse struct {
	Methods       []string              `json:"methods" doc:"How the user can confirm who they are, strongest first: passkey, totp (authenticator app), email (emailed code), or only sso when their organization enforces single sign-on. email is not offered when two-factor authentication is on."`
	Passkey       *ReauthPasskeyOptions `json:"passkey,omitempty" doc:"Present when passkey is a method."`
	SSOURL        string                `json:"sso_url,omitempty" doc:"Present when sso is the method: open it in the browser to authenticate again at the identity provider (prompt=login, max_age=0). It ends in a new session."`
	EmailCodeSent bool                  `json:"email_code_sent" doc:"True when send_email_code emailed a new code."`
	RetryAfter    int                   `json:"retry_after,omitempty" minimum:"1" doc:"With send_email_code: seconds before another code can be requested."`
}

// ReauthOptionsOutput is the response of POST /api/v1/auth/reauth/options.
type ReauthOptionsOutput struct {
	Body ReauthOptionsResponse
}

// ReauthVerifyBody is the request body of POST /api/v1/auth/reauth/verify.
type ReauthVerifyBody struct {
	Method      string          `json:"method" enum:"passkey,totp,email" doc:"The method used; one of the options' methods."`
	Code        string          `json:"code,omitempty" maxLength:"64" doc:"totp: the current 6-digit code from the authenticator app. email: the emailed code (spaces and hyphens are ignored)."`
	ChallengeID string          `json:"challenge_id,omitempty" maxLength:"128" doc:"passkey: the challenge_id of the options response."`
	Response    json.RawMessage `json:"response,omitempty" doc:"passkey: the PublicKeyCredential from navigator.credentials.get(), JSON-encoded."`
}

// ReauthVerifyInput is the request of POST /api/v1/auth/reauth/verify.
type ReauthVerifyInput struct {
	Body ReauthVerifyBody
}

// ReauthVerifyResponse is the body of POST /api/v1/auth/reauth/verify.
type ReauthVerifyResponse struct {
	AccessToken string    `json:"access_token" doc:"New RS256 access token whose auth_time is now. The refresh token does not change; refreshes keep the new authentication time."`
	ExpiresIn   int       `json:"expires_in" minimum:"1" doc:"Seconds until the access token expires."`
	AuthTime    time.Time `json:"auth_time" doc:"The session's new authentication time."`
}

// ReauthVerifyOutput is the response of POST /api/v1/auth/reauth/verify.
type ReauthVerifyOutput struct {
	Body ReauthVerifyResponse
}

// Reauth serves POST /api/v1/auth/reauth/options and …/verify.
type Reauth struct {
	deps     ReauthDeps
	limiter  *ratelimit.Limiter
	perUser  ratelimit.Rate
	perEmail ratelimit.Rate
	logger   *slog.Logger
	now      func() time.Time
}

// NewReauth returns the re-authentication endpoints. limiter enforces
// identity.rate_limits.second_factor_per_user on verify and
// email_start_per_email on emailed codes.
func NewReauth(cfg config.IdentityConfig, deps ReauthDeps, limiter *ratelimit.Limiter, logger *slog.Logger) *Reauth {
	return &Reauth{
		deps:     deps,
		limiter:  limiter,
		perUser:  ratelimit.Rate(cfg.RateLimits.SecondFactorPerUser),
		perEmail: ratelimit.Rate(cfg.RateLimits.EmailStartPerEmail),
		logger:   logger,
		now:      time.Now,
	}
}

// Register mounts the re-authentication endpoints. They need a user
// session: install authn.Middleware on api first.
func (r *Reauth) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "reauth-options",
		Method:      http.MethodPost,
		Path:        ReauthPrefix + "/options",
		Summary:     "Start confirming who you are again",
		Description: "For a signed-in user whose sensitive action answered `reauth_required`: lists how they can confirm who they are without signing out. " +
			"`passkey` (with WebAuthn `options` limited to their passkeys) when they have one, `totp` when two-factor authentication is on, and `email` (a 6-digit code to their address) when it is off. " +
			"A user whose organization enforces single sign-on gets only `sso` and an `sso_url` that sends them through the identity provider with `prompt=login` and `max_age=0`. " +
			"`send_email_code: true` emails the code (15 minutes, 5 attempts); within 30 seconds of the previous one no new email is sent. Email codes are rate-limited per address (429 `rate_limited` with Retry-After).",
		Tags:     []string{server.TagAuth},
		Security: security,
	}, CodeInvalidRequest, CodeUnauthenticated, CodeSessionExpired, CodeRateLimited, CodeInternal), r.options)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "reauth-verify",
		Method:      http.MethodPost,
		Path:        ReauthPrefix + "/verify",
		Summary:     "Confirm who you are again",
		Description: "Checks a passkey assertion (`challenge_id` and `response`), a code from the authenticator app or the emailed code, for one of the methods `/reauth/options` listed. " +
			"On success the session's authentication time becomes now (refreshes keep it) and the answer carries a new access token whose `auth_time` is now, so sensitive actions pass for `identity.sensitive_action_max_age`. " +
			"Audited as `session.reauthenticated`; failures as `session.reauth_failed`. " +
			"A wrong code answers `invalid_code`; an emailed code locks after 5 wrong guesses (`too_many_attempts`, request a new one), and every method is rate-limited per user (429 `rate_limited` with Retry-After), so repeated failures lock re-authentication out for a while. " +
			"A method the user does not have answers `invalid_request`; a user whose organization enforces single sign-on gets 403 `sso_required` with the `start_url` to re-authenticate at.",
		Tags:     []string{server.TagAuth},
		Security: security,
	}, CodeInvalidRequest, CodeInvalidCode, CodeCodeExpired, CodeTooManyAttempts, CodePasskeyUnknown, CodePasskeyFailed,
		CodeSSORequired, CodeUnauthenticated, CodeSessionExpired, CodeRateLimited, CodeInternal), r.verify)
}

// reauthFacts is what decides a user's re-authentication methods.
type reauthFacts struct {
	user     db.User
	passkeys bool
	totp     bool
	ssoURL   string // set when the user's organization enforces SSO
}

func (f reauthFacts) methods() []string {
	if f.ssoURL != "" {
		return []string{ReauthSSO}
	}
	var m []string
	if f.passkeys {
		m = append(m, ReauthPasskey)
	}
	if f.totp {
		m = append(m, ReauthTOTP)
	} else {
		// With two-factor on, an emailed code alone would be weaker than
		// signing in.
		m = append(m, ReauthEmail)
	}
	return m
}

func (f reauthFacts) has(method string) bool {
	for _, m := range f.methods() {
		if m == method {
			return true
		}
	}
	return false
}

// facts loads the signed-in user and their methods. A deleted user answers
// session_expired.
func (r *Reauth) facts(ctx context.Context, user uuid.UUID, next string) (reauthFacts, error) {
	u, err := r.deps.Users.GetUserByID(ctx, user)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return reauthFacts{}, Err(CodeSessionExpired)
	case err != nil:
		r.logger.ErrorContext(ctx, "reauth: load user", "error", err, "user_id", user)
		return reauthFacts{}, Err(CodeInternal)
	}
	f := reauthFacts{user: u}
	startURL, required, err := r.deps.SSO.Required(ctx, u.Email)
	if err != nil {
		r.logger.ErrorContext(ctx, "reauth: sso enforcement", "error", err, "user_id", user)
		return reauthFacts{}, Err(CodeInternal)
	}
	if required {
		q := url.Values{"reauth": {"true"}, "login_hint": {u.Email}}
		if next != "" {
			q.Set("next", next)
		}
		f.ssoURL = startURL + "?" + q.Encode()
		return f, nil
	}
	n, err := r.deps.Users.CountPasskeyCredentialsForUser(ctx, user)
	if err != nil {
		r.logger.ErrorContext(ctx, "reauth: count passkeys", "error", err, "user_id", user)
		return reauthFacts{}, Err(CodeInternal)
	}
	f.passkeys = n > 0
	row, err := r.deps.Users.GetTOTPForUser(ctx, user)
	switch {
	case err == nil:
		f.totp = row.ConfirmedAt != nil
	case !errors.Is(err, pgx.ErrNoRows):
		r.logger.ErrorContext(ctx, "reauth: load totp", "error", err, "user_id", user)
		return reauthFacts{}, Err(CodeInternal)
	}
	return f, nil
}

func (r *Reauth) options(ctx context.Context, in *ReauthOptionsInput) (*ReauthOptionsOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	var body ReauthOptionsBody
	if in.Body != nil {
		body = *in.Body
	}
	var next string
	if body.Next != "" {
		n, ok := SafeNext(body.Next)
		if !ok {
			return nil, Err(CodeInvalidRequest)
		}
		next = n
	}
	f, err := r.facts(ctx, p.UserID, next)
	if err != nil {
		return nil, err
	}
	out := &ReauthOptionsOutput{Body: ReauthOptionsResponse{Methods: f.methods(), SSOURL: f.ssoURL}}
	if f.passkeys && f.ssoURL == "" {
		id, assertion, err := r.deps.Passkeys.Options(ctx, f.user.Email)
		if err != nil {
			r.logger.ErrorContext(ctx, "reauth options: passkey", "error", err, "user_id", p.UserID)
			return nil, Err(CodeInternal)
		}
		b, err := json.Marshal(assertion)
		if err != nil {
			r.logger.ErrorContext(ctx, "reauth options: encode passkey options", "error", err)
			return nil, Err(CodeInternal)
		}
		out.Body.Passkey = &ReauthPasskeyOptions{ChallengeID: id, Options: b}
	}
	if body.SendEmailCode {
		if !f.has(ReauthEmail) {
			return nil, Err(CodeInvalidRequest)
		}
		sent, wait, err := r.sendCode(ctx, f.user)
		if err != nil {
			return nil, err
		}
		out.Body.EmailCodeSent = sent
		out.Body.RetryAfter = max(1, int(math.Ceil(wait.Seconds())))
	}
	return out, nil
}

// sendCode emails a re-authentication code to user unless one went out
// within EmailResendCooldown. It returns whether it sent one and the wait
// before the next.
func (r *Reauth) sendCode(ctx context.Context, user db.User) (bool, time.Duration, error) {
	res, err := r.limiter.Allow(ctx, "reauth_email:email", user.Email, r.perEmail)
	if err != nil {
		r.logger.ErrorContext(ctx, "reauth options: rate limiter unavailable; refusing", "error", err)
		return false, 0, huma.Error503ServiceUnavailable("rate limiter unavailable, retry later")
	}
	if !res.Allowed {
		return false, 0, ErrRetryAfter(CodeRateLimited, res.RetryAfter)
	}
	latest, found, err := r.deps.Codes.Latest(ctx, user.Email)
	if err != nil {
		r.logger.ErrorContext(ctx, "reauth options: latest email", "error", err)
		return false, 0, Err(CodeInternal)
	}
	if found {
		// As in email start: the issue time from this process's clock.
		issuedAt := latest.ExpiresAt.Add(-emailauth.TTL)
		if wait := min(issuedAt.Add(EmailResendCooldown).Sub(r.now()), EmailResendCooldown); wait > 0 {
			return false, wait, nil
		}
	}
	req := audit.RequestFrom(ctx)
	opts := emailauth.IssueOptions{UserID: &user.ID, UserAgent: req.UserAgent}
	if req.IP.IsValid() {
		ip := req.IP
		opts.IP = &ip
	}
	// The code is checked like a sign-in code: against the address's latest
	// email, at most emailauth.MaxAttempts wrong guesses.
	issued, err := r.deps.Codes.Issue(ctx, user.Email, emailauth.IntentSignIn, opts)
	if err != nil {
		r.logger.ErrorContext(ctx, "reauth options: issue code", "error", err)
		return false, 0, Err(CodeInternal)
	}
	job := email.SendArgs{To: user.Email, Template: email.TemplateReauthCode, Data: map[string]any{
		"code":       issued.Code,
		"expires_in": fmt.Sprintf("%d minutes", int(emailauth.TTL/time.Minute)),
	}}
	if _, err := r.deps.Jobs.Insert(ctx, job, nil); err != nil {
		r.logger.ErrorContext(ctx, "reauth options: enqueue email", "error", err)
		return false, 0, Err(CodeInternal)
	}
	return true, EmailResendCooldown, nil
}

func (r *Reauth) verify(ctx context.Context, in *ReauthVerifyInput) (*ReauthVerifyOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	method := in.Body.Method
	f, err := r.facts(ctx, p.UserID, "")
	if err != nil {
		return nil, err
	}
	if f.ssoURL != "" {
		return nil, ErrSSORequired(f.ssoURL)
	}
	if !f.has(method) {
		return nil, Err(CodeInvalidRequest)
	}
	res, err := r.limiter.Allow(ctx, "reauth_verify:user", p.UserID.String(), r.perUser)
	if err != nil {
		r.logger.ErrorContext(ctx, "reauth verify: rate limiter unavailable; refusing", "error", err)
		return nil, huma.Error503ServiceUnavailable("rate limiter unavailable, retry later")
	}
	if !res.Allowed {
		r.fail(ctx, p.UserID, method, "rate_limited")
		return nil, ErrRetryAfter(CodeRateLimited, res.RetryAfter)
	}

	switch method {
	case ReauthPasskey:
		err = r.checkPasskey(ctx, p.UserID, in.Body)
	case ReauthTOTP:
		err = r.checkTOTP(ctx, p.UserID, in.Body.Code)
	case ReauthEmail:
		err = r.checkEmail(ctx, p.UserID, f.user.Email, in.Body.Code)
	default:
		err = Err(CodeInvalidRequest)
	}
	if err != nil {
		return nil, err
	}

	ra, err := r.deps.Sessions.Reauthenticate(ctx, p.UserID, p.SessionID)
	switch {
	case err == nil:
	case errors.Is(err, session.ErrExpired):
		return nil, Err(CodeSessionExpired)
	default:
		r.logger.ErrorContext(ctx, "reauth verify: update session", "error", err, "user_id", p.UserID)
		return nil, Err(CodeInternal)
	}
	if err := r.deps.Audit.Record(ctx, audit.Event{
		User:  &p.UserID,
		Actor: &p.UserID,
		Kind:  audit.SessionReauthenticated,
		Meta:  map[string]any{"method": method, "session_id": ra.Session.ID.String()},
	}); err != nil {
		r.logger.ErrorContext(ctx, "reauth verify: audit", "error", err, "user_id", p.UserID)
	}
	return &ReauthVerifyOutput{Body: ReauthVerifyResponse{
		AccessToken: ra.AccessToken,
		ExpiresIn:   max(1, int(math.Ceil(ra.AccessExpiresAt.Sub(r.now()).Seconds()))),
		AuthTime:    ra.AuthTime.UTC(),
	}}, nil
}

func (r *Reauth) checkPasskey(ctx context.Context, user uuid.UUID, b ReauthVerifyBody) error {
	if b.ChallengeID == "" || len(b.Response) == 0 || len(b.Response) > maxPasskeyResponse || string(b.Response) == "null" {
		return Err(CodeInvalidRequest)
	}
	res, err := r.deps.Passkeys.Verify(ctx, b.ChallengeID, b.Response)
	switch {
	case err == nil:
	case errors.Is(err, passkey.ErrUnknownCredential):
		return r.reject(ctx, user, ReauthPasskey, "unknown_credential", CodePasskeyUnknown)
	case errors.Is(err, passkey.ErrCloned):
		return r.reject(ctx, user, ReauthPasskey, "sign_count_regressed", CodePasskeyFailed)
	case errors.Is(err, passkey.ErrChallengeNotFound):
		return r.reject(ctx, user, ReauthPasskey, "challenge_not_found", CodePasskeyFailed)
	case errors.Is(err, passkey.ErrVerification):
		return r.reject(ctx, user, ReauthPasskey, "verification_failed", CodePasskeyFailed)
	default:
		r.logger.ErrorContext(ctx, "reauth verify: passkey", "error", err, "user_id", user)
		return Err(CodeInternal)
	}
	if res.User.ID != user {
		// A valid passkey of another account proves nothing about this one.
		return r.reject(ctx, user, ReauthPasskey, "other_account", CodePasskeyFailed)
	}
	return nil
}

func (r *Reauth) checkTOTP(ctx context.Context, user uuid.UUID, code string) error {
	if code == "" {
		return Err(CodeInvalidRequest)
	}
	_, _, err := r.deps.TwoFactor.SignIn(ctx, user, twofactor.Proof{Code: code})
	switch {
	case err == nil:
		return nil
	case errors.Is(err, twofactor.ErrInvalidCode):
		return r.reject(ctx, user, ReauthTOTP, string(CodeInvalidCode), CodeInvalidCode)
	case errors.Is(err, twofactor.ErrNotEnabled), errors.Is(err, twofactor.ErrProofRequired):
		return Err(CodeInvalidRequest)
	case errors.Is(err, twofactor.ErrUserNotFound):
		return Err(CodeSessionExpired)
	case errors.Is(err, idkeys.ErrDecrypt):
		r.logger.ErrorContext(ctx, "reauth verify: cannot decrypt stored TOTP secret (wrong key encryption key?)", "user_id", user)
		return Err(CodeInternal)
	default:
		r.logger.ErrorContext(ctx, "reauth verify: totp", "error", err, "user_id", user)
		return Err(CodeInternal)
	}
}

func (r *Reauth) checkEmail(ctx context.Context, user uuid.UUID, addr, code string) error {
	if code == "" {
		return Err(CodeInvalidRequest)
	}
	_, err := r.deps.Codes.VerifyCode(ctx, addr, code)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, emailauth.ErrInvalidCode):
		return r.reject(ctx, user, ReauthEmail, string(CodeInvalidCode), CodeInvalidCode)
	case errors.Is(err, emailauth.ErrCodeExpired):
		return r.reject(ctx, user, ReauthEmail, string(CodeCodeExpired), CodeCodeExpired)
	case errors.Is(err, emailauth.ErrTooManyAttempts):
		return r.reject(ctx, user, ReauthEmail, string(CodeTooManyAttempts), CodeTooManyAttempts)
	default:
		r.logger.ErrorContext(ctx, "reauth verify: email code", "error", err, "user_id", user)
		return Err(CodeInternal)
	}
}

// reject audits a failed attempt and returns the problem for code.
func (r *Reauth) reject(ctx context.Context, user uuid.UUID, method, reason string, code ErrCode) error {
	r.fail(ctx, user, method, reason)
	return Err(code)
}

// fail audits session.reauth_failed. A failure to record is logged only.
func (r *Reauth) fail(ctx context.Context, user uuid.UUID, method, reason string) {
	if err := r.deps.Audit.Record(ctx, audit.Event{
		User:  &user,
		Actor: &user,
		Kind:  audit.SessionReauthFailed,
		Meta:  map[string]any{"method": method, "reason": reason},
	}); err != nil {
		r.logger.ErrorContext(ctx, "reauth verify: audit", "error", err, "user_id", user)
	}
}

// Compile-time checks of the production collaborators.
var (
	_ ReauthSessions       = (*session.Service)(nil)
	_ ReauthUsers          = (*db.Queries)(nil)
	_ ReauthCodes          = (*emailauth.Service)(nil)
	_ ReauthTwoFactor      = (*twofactor.Service)(nil)
	_ PasskeyAuthenticator = (*passkey.Login)(nil)
)
