package identity

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// PasskeyLoginPrefix is the path prefix of the passkey sign-in ceremony.
const PasskeyLoginPrefix = AuthPrefix + "/passkeys/login"

// PasskeyAuthenticator runs the discoverable sign-in ceremony;
// *passkey.Login satisfies it.
type PasskeyAuthenticator interface {
	Options(ctx context.Context, email string) (string, *protocol.CredentialAssertion, error)
	Verify(ctx context.Context, challengeID string, response []byte) (passkey.LoginResult, error)
}

// LastLoginToucher records a completed sign-in; *PGSignInUsers satisfies
// it.
type LastLoginToucher interface {
	TouchLastLogin(ctx context.Context, user uuid.UUID) error
}

// PasskeyLoginDeps are the collaborators of the passkey sign-in endpoints.
type PasskeyLoginDeps struct {
	Login    PasskeyAuthenticator
	Users    LastLoginToucher
	Sessions SessionCreator
	Audit    AuditRecorder
}

// PasskeyLoginOptionsBody is the optional request body of POST
// …/passkeys/login/options.
type PasskeyLoginOptionsBody struct {
	Email string `json:"email,omitempty" maxLength:"254" doc:"Optional hint. When it names an account with passkeys, allowCredentials lists them; otherwise the options are fully discoverable."`
}

// PasskeyLoginOptionsInput is the request of POST …/passkeys/login/options.
type PasskeyLoginOptionsInput struct {
	Body *PasskeyLoginOptionsBody
}

// PasskeyLoginOptionsResponse is the body of POST …/passkeys/login/options.
type PasskeyLoginOptionsResponse struct {
	ChallengeID string          `json:"challenge_id" doc:"Send back with the verify request. Valid for 5 minutes, once."`
	Options     json.RawMessage `json:"options" doc:"CredentialRequestOptions ({publicKey: ...}) for navigator.credentials.get(); add mediation: \"conditional\" for autofill."`
}

// PasskeyLoginOptionsOutput is the response of POST
// …/passkeys/login/options.
type PasskeyLoginOptionsOutput struct {
	Body PasskeyLoginOptionsResponse
}

// PasskeyLoginVerifyBody is the request body of POST
// …/passkeys/login/verify.
type PasskeyLoginVerifyBody struct {
	ChallengeID string          `json:"challenge_id" minLength:"1" maxLength:"128" doc:"The challenge_id from the options response."`
	Response    json.RawMessage `json:"response" doc:"The PublicKeyCredential from navigator.credentials.get(), JSON-encoded (PublicKeyCredential.toJSON())."`
	Remember    bool            `json:"remember,omitempty" doc:"Keep the session for identity.refresh_token_ttl (30 days) instead of identity.refresh_token_ttl_short (24 hours)."`
	Next        string          `json:"next,omitempty" maxLength:"512" doc:"Relative path (starting with a single /) to open after sign-in; echoed back."`
}

// PasskeyLoginVerifyInput is the request of POST …/passkeys/login/verify.
type PasskeyLoginVerifyInput struct {
	Body PasskeyLoginVerifyBody
}

// PasskeyLogin serves the passkey sign-in endpoints.
type PasskeyLogin struct {
	deps    PasskeyLoginDeps
	limiter *ratelimit.Limiter
	perIP   ratelimit.Rate
	logger  *slog.Logger
	now     func() time.Time
}

// NewPasskeyLogin returns the passkey sign-in endpoints. limiter enforces
// identity.rate_limits.passkey_login_per_ip on each of them.
func NewPasskeyLogin(cfg config.IdentityConfig, deps PasskeyLoginDeps, limiter *ratelimit.Limiter, logger *slog.Logger) *PasskeyLogin {
	return &PasskeyLogin{
		deps:    deps,
		limiter: limiter,
		perIP:   ratelimit.Rate(cfg.RateLimits.PasskeyLoginPerIP),
		logger:  logger,
		now:     time.Now,
	}
}

// Register mounts POST …/passkeys/login/options and …/login/verify. Both
// are public.
func (p *PasskeyLogin) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "passkey-login-options",
		Method:      http.MethodPost,
		Path:        PasskeyLoginPrefix + "/options",
		Summary:     "Start signing in with a passkey",
		Description: "Public. Starts a discoverable (username-less) passkey sign-in, also usable for conditional UI (autofill). " +
			"Returns a `challenge_id` (valid 5 minutes, once) and the `options` for `navigator.credentials.get()`. " +
			"An optional `email` hint narrows `allowCredentials` to that account's passkeys; an unknown address gets fully discoverable options. " +
			"Rate-limited per IP (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{p.limiter.Limit(api, "passkey_login_options", p.perIP, ratelimit.Key{})},
	}, CodeInvalidRequest, CodeRateLimited, CodeInternal), p.options)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "passkey-login-verify",
		Method:      http.MethodPost,
		Path:        PasskeyLoginPrefix + "/verify",
		Summary:     "Sign in with a passkey",
		Description: "Public. Verifies the authenticator's assertion for the options of `challenge_id`, resolving the user from the passkey's user handle, " +
			"and answers the session bundle (`amr: [\"passkey\"]`; `remember` picks the session lifetime) with `next` echoed. " +
			"A passkey is phishing-resistant and user-verifying, so two-factor authentication is not asked for. " +
			"Answers 401 `passkey_unknown` for a passkey that is not registered, and 401 `passkey_failed` when the challenge is unknown, expired or used, " +
			"the assertion does not verify, or its signature counter went backwards (a possibly cloned authenticator). " +
			"Rate-limited per IP (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{p.limiter.Limit(api, "passkey_login_verify", p.perIP, ratelimit.Key{})},
	}, CodeInvalidRequest, CodePasskeyUnknown, CodePasskeyFailed, CodeRateLimited, CodeInternal), p.verify)
}

func (p *PasskeyLogin) options(ctx context.Context, in *PasskeyLoginOptionsInput) (*PasskeyLoginOptionsOutput, error) {
	var addr string
	if in.Body != nil && in.Body.Email != "" {
		var ok bool
		if addr, ok = NormalizeEmail(in.Body.Email); !ok {
			return nil, Err(CodeInvalidRequest)
		}
	}
	id, assertion, err := p.deps.Login.Options(ctx, addr)
	if err != nil {
		p.logger.ErrorContext(ctx, "passkey login options", "error", err)
		return nil, Err(CodeInternal)
	}
	b, err := json.Marshal(assertion)
	if err != nil {
		p.logger.ErrorContext(ctx, "passkey login options: encode", "error", err)
		return nil, Err(CodeInternal)
	}
	return &PasskeyLoginOptionsOutput{Body: PasskeyLoginOptionsResponse{ChallengeID: id, Options: b}}, nil
}

func (p *PasskeyLogin) verify(ctx context.Context, in *PasskeyLoginVerifyInput) (*SignInOutput, error) {
	if len(in.Body.Response) == 0 || len(in.Body.Response) > maxPasskeyResponse || string(in.Body.Response) == "null" {
		return nil, Err(CodeInvalidRequest)
	}
	var next string
	if in.Body.Next != "" {
		n, ok := SafeNext(in.Body.Next)
		if !ok {
			return nil, Err(CodeInvalidRequest)
		}
		next = n
	}

	res, err := p.deps.Login.Verify(ctx, in.Body.ChallengeID, in.Body.Response)
	switch {
	case err == nil:
	case errors.Is(err, passkey.ErrUnknownCredential):
		return nil, p.fail(ctx, nil, CodePasskeyUnknown, "unknown_credential", err)
	case errors.Is(err, passkey.ErrCloned):
		return nil, p.fail(ctx, &res, CodePasskeyFailed, "sign_count_regressed", err)
	case errors.Is(err, passkey.ErrChallengeNotFound):
		return nil, p.fail(ctx, nil, CodePasskeyFailed, "challenge_not_found", err)
	case errors.Is(err, passkey.ErrVerification):
		return nil, p.fail(ctx, nil, CodePasskeyFailed, "verification_failed", err)
	default:
		p.logger.ErrorContext(ctx, "passkey login verify", "error", err)
		return nil, Err(CodeInternal)
	}

	user := res.User
	remember := in.Body.Remember
	t, err := p.deps.Sessions.Create(ctx, user, remember, session.Meta{AMR: []string{token.AMRPasskey}})
	if err != nil {
		p.logger.ErrorContext(ctx, "passkey login verify: create session", "error", err, "user_id", user.ID)
		return nil, Err(CodeInternal)
	}
	// The session exists: bookkeeping failures below are logged, not
	// returned.
	if err := p.deps.Users.TouchLastLogin(ctx, user.ID); err != nil {
		p.logger.ErrorContext(ctx, "passkey login verify: touch last login", "error", err, "user_id", user.ID)
	}
	if err := p.deps.Audit.Record(ctx, audit.Event{
		User:  &user.ID,
		Actor: &user.ID,
		Kind:  audit.LoginSucceeded,
		Meta: map[string]any{
			"method":     "passkey",
			"passkey_id": res.Credential.ID.String(),
			"session_id": t.Session.ID.String(),
			"remember":   remember,
		},
	}); err != nil {
		p.logger.ErrorContext(ctx, "passkey login verify: audit", "error", err, "user_id", user.ID)
	}
	return &SignInOutput{Body: NewSignInSession(t, next, p.now())}, nil
}

// fail audits login.failed and returns the problem for code. res names the
// user and passkey when they are known (a regressed counter).
func (p *PasskeyLogin) fail(ctx context.Context, res *passkey.LoginResult, code ErrCode, reason string, cause error) error {
	p.logger.InfoContext(ctx, "passkey login verify rejected", "reason", reason, "error", cause)
	ev := audit.Event{Kind: audit.LoginFailed, Meta: map[string]any{"method": "passkey", "reason": reason}}
	if res != nil && res.User.ID != uuid.Nil {
		ev.User = &res.User.ID
		ev.Meta["passkey_id"] = res.Credential.ID.String()
	}
	if err := p.deps.Audit.Record(ctx, ev); err != nil {
		p.logger.ErrorContext(ctx, "passkey login verify: audit", "error", err)
	}
	return Err(code)
}
