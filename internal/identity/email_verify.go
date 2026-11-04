package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// defaultPreAuthTTL applies when identity.pre_auth_ttl is unset (tests, the
// OpenAPI dump); config validation requires it in a running server.
const defaultPreAuthTTL = 5 * time.Minute

// EmailCodes verifies emailed sign-in codes; *emailauth.Service satisfies it.
type EmailCodes interface {
	VerifyCode(ctx context.Context, email, code string) (db.AuthEmailToken, error)
}

// SessionCreator starts sessions; *session.Service satisfies it.
type SessionCreator interface {
	Create(ctx context.Context, user db.User, remember bool, meta session.Meta) (session.Tokens, error)
}

// EmailVerifyDeps are the collaborators of the email-verify endpoint.
type EmailVerifyDeps struct {
	Codes    EmailCodes
	Users    SignInUsers
	Sessions SessionCreator
	PreAuth  PreAuthStore
	Audit    AuditRecorder
}

// EmailVerifyBody is the request body of POST /api/v1/auth/email/verify.
type EmailVerifyBody struct {
	Email    string `json:"email" format:"email" minLength:"3" maxLength:"254" doc:"Address the code was emailed to."`
	Code     string `json:"code" minLength:"1" maxLength:"64" doc:"The 6-digit code from the email. Spaces and hyphens are ignored."`
	Remember bool   `json:"remember,omitempty" doc:"Keep the session for identity.refresh_token_ttl (30 days) instead of identity.refresh_token_ttl_short (24 hours)."`
}

// EmailVerifyInput is the request of POST /api/v1/auth/email/verify.
type EmailVerifyInput struct {
	Body EmailVerifyBody
}

// SignInOutput is the response of a first-factor sign-in.
type SignInOutput struct {
	Body SignInResponse
}

// EmailVerify serves POST /api/v1/auth/email/verify.
type EmailVerify struct {
	deps       EmailVerifyDeps
	limiter    *ratelimit.Limiter
	perEmail   ratelimit.Rate
	preAuthTTL time.Duration
	logger     *slog.Logger
	now        func() time.Time
}

// NewEmailVerify returns the email-verify endpoint. limiter enforces
// identity.rate_limits.code_verify_per_email.
func NewEmailVerify(cfg config.IdentityConfig, deps EmailVerifyDeps, limiter *ratelimit.Limiter, logger *slog.Logger) *EmailVerify {
	ttl := cfg.PreAuthTTL
	if ttl <= 0 {
		ttl = defaultPreAuthTTL
	}
	return &EmailVerify{
		deps:       deps,
		limiter:    limiter,
		perEmail:   ratelimit.Rate(cfg.RateLimits.CodeVerifyPerEmail),
		preAuthTTL: ttl,
		logger:     logger,
		now:        time.Now,
	}
}

// Register mounts POST /api/v1/auth/email/verify.
func (e *EmailVerify) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "verify-email-code",
		Method:      http.MethodPost,
		Path:        AuthPrefix + "/email/verify",
		Summary:     "Sign in with an emailed code",
		Description: "Public. Checks the 6-digit code of the latest sign-in email sent to the address and consumes it. " +
			"The user is found or, on first sign-in, created, and the address is marked verified. " +
			"Answers the session bundle (`amr: [\"email\"]`; `remember` picks the session lifetime) or, " +
			"when the user has two-factor authentication enabled, `{status: \"2fa_required\", pre_auth_token}`. " +
			"Either answer carries the `next` path the email was requested with. " +
			"A wrong code, an unknown address and an address with no outstanding email all answer `invalid_code`; " +
			"the fifth wrong code locks the email (`too_many_attempts`) until a new one is requested. " +
			"Rate-limited per email address (429 `rate_limited` with Retry-After).",
		Tags: []string{server.TagAuth},
	}, CodeInvalidRequest, CodeInvalidCode, CodeCodeExpired, CodeTooManyAttempts, CodeRateLimited, CodeInternal), e.verify)
}

func (e *EmailVerify) verify(ctx context.Context, in *EmailVerifyInput) (*SignInOutput, error) {
	addr, ok := NormalizeEmail(in.Body.Email)
	if !ok {
		return nil, Err(CodeInvalidRequest)
	}

	res, err := e.limiter.Allow(ctx, "code_verify:email", addr, e.perEmail)
	if err != nil {
		e.logger.ErrorContext(ctx, "email verify: rate limiter unavailable; refusing", "error", err)
		return nil, huma.Error503ServiceUnavailable("rate limiter unavailable, retry later")
	}
	if !res.Allowed {
		return nil, ErrRetryAfter(CodeRateLimited, res.RetryAfter)
	}

	row, err := e.deps.Codes.VerifyCode(ctx, addr, in.Body.Code)
	switch {
	case err == nil:
	case errors.Is(err, emailauth.ErrInvalidCode):
		return nil, e.fail(ctx, addr, CodeInvalidCode)
	case errors.Is(err, emailauth.ErrCodeExpired):
		return nil, e.fail(ctx, addr, CodeCodeExpired)
	case errors.Is(err, emailauth.ErrTooManyAttempts):
		return nil, e.fail(ctx, addr, CodeTooManyAttempts)
	default:
		e.logger.ErrorContext(ctx, "email verify: verify code", "error", err)
		return nil, Err(CodeInternal)
	}
	// Only sign-in and sign-up emails sign in; a code sent to verify or
	// change an address does not.
	if intent := emailauth.Intent(row.Intent); intent != emailauth.IntentSignIn && intent != emailauth.IntentSignUp {
		return nil, e.fail(ctx, addr, CodeInvalidCode)
	}
	var next string
	if row.NextPath != nil {
		next = *row.NextPath
	}

	user, _, err := e.deps.Users.FindOrCreateVerified(ctx, addr)
	if err != nil {
		e.logger.ErrorContext(ctx, "email verify: find or create user", "error", err)
		return nil, Err(CodeInternal)
	}
	amr := []string{token.AMREmail}

	twoFactor, err := e.deps.Users.TOTPConfirmed(ctx, user.ID)
	if err != nil {
		e.logger.ErrorContext(ctx, "email verify: load two-factor state", "error", err, "user_id", user.ID)
		return nil, Err(CodeInternal)
	}
	if twoFactor {
		pre, err := e.deps.PreAuth.Issue(ctx, PreAuth{UserID: user.ID, AMR: amr, Remember: in.Body.Remember, Next: next}, e.preAuthTTL)
		if err != nil {
			e.logger.ErrorContext(ctx, "email verify: issue pre-auth token", "error", err, "user_id", user.ID)
			return nil, Err(CodeInternal)
		}
		return &SignInOutput{Body: NewSignInTwoFactor(pre, next)}, nil
	}

	t, err := e.deps.Sessions.Create(ctx, user, in.Body.Remember, session.Meta{AMR: amr})
	if err != nil {
		e.logger.ErrorContext(ctx, "email verify: create session", "error", err, "user_id", user.ID)
		return nil, Err(CodeInternal)
	}
	// The session exists: bookkeeping failures below are logged, not
	// returned.
	if err := e.deps.Users.TouchLastLogin(ctx, user.ID); err != nil {
		e.logger.ErrorContext(ctx, "email verify: touch last login", "error", err, "user_id", user.ID)
	}
	if err := e.deps.Audit.Record(ctx, audit.Event{
		User:  &user.ID,
		Actor: &user.ID,
		Kind:  audit.LoginSucceeded,
		Meta:  map[string]any{"method": "email", "session_id": t.Session.ID.String(), "remember": in.Body.Remember},
	}); err != nil {
		e.logger.ErrorContext(ctx, "email verify: audit", "error", err, "user_id", user.ID)
	}
	return &SignInOutput{Body: NewSignInSession(t, next, e.now())}, nil
}

// fail audits login.failed and returns the problem for code. The user is not
// looked up, so the audit trail costs no extra query per guess.
func (e *EmailVerify) fail(ctx context.Context, addr string, code ErrCode) error {
	if err := e.deps.Audit.Record(ctx, audit.Event{
		Kind: audit.LoginFailed,
		Meta: map[string]any{"method": "email", "email": addr, "reason": string(code)},
	}); err != nil {
		e.logger.ErrorContext(ctx, "email verify: audit", "error", err)
	}
	return Err(code)
}
