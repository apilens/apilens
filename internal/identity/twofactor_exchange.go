package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/platform/server"
)

// TwoFactorSignIn checks the second factor of a sign-in;
// *twofactor.Service satisfies it.
type TwoFactorSignIn interface {
	SignIn(ctx context.Context, user uuid.UUID, p twofactor.Proof) (db.User, string, error)
}

// TwoFactorExchangeDeps are the collaborators of POST
// /api/v1/auth/2fa/exchange.
type TwoFactorExchangeDeps struct {
	PreAuth   PreAuthRedeemer
	TwoFactor TwoFactorSignIn
	Users     LastLoginToucher
	Sessions  SessionCreator
	Audit     AuditRecorder
}

// TwoFactorExchangeBody is the request body of POST
// /api/v1/auth/2fa/exchange.
type TwoFactorExchangeBody struct {
	PreAuthToken string `json:"pre_auth_token" minLength:"1" maxLength:"128" doc:"The pre_auth_token of the 2fa_required sign-in answer."`
	Code         string `json:"code,omitempty" required:"false" pattern:"^[0-9]{6}$" doc:"Current 6-digit code from the authenticator app. Send this or backup_code, not both."`
	BackupCode   string `json:"backup_code,omitempty" required:"false" minLength:"1" maxLength:"32" doc:"An unused backup code (xxxx-xxxx; case, dashes and spaces are ignored). It is spent. Send this or code, not both."`
}

// TwoFactorExchangeInput is the request of POST /api/v1/auth/2fa/exchange.
type TwoFactorExchangeInput struct {
	Body TwoFactorExchangeBody
}

// TwoFactorExchange serves POST /api/v1/auth/2fa/exchange: the second step
// of a sign-in that answered 2fa_required.
type TwoFactorExchange struct {
	deps   TwoFactorExchangeDeps
	logger *slog.Logger
	now    func() time.Time
}

// NewTwoFactorExchange returns the 2FA exchange endpoint.
func NewTwoFactorExchange(deps TwoFactorExchangeDeps, logger *slog.Logger) *TwoFactorExchange {
	return &TwoFactorExchange{deps: deps, logger: logger, now: time.Now}
}

// Register mounts POST /api/v1/auth/2fa/exchange. It is public: the
// pre-auth token in the body is the credential, and it is accepted nowhere
// else.
func (x *TwoFactorExchange) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "exchange-2fa",
		Method:      http.MethodPost,
		Path:        TwoFactorPrefix + "/exchange",
		Summary:     "Finish signing in with a second factor",
		Description: "Public. Completes an email, social or SSO sign-in that answered `{status: \"2fa_required\", pre_auth_token}`. " +
			"Send the `pre_auth_token` with exactly one of `code` (from the authenticator app) or `backup_code` (`invalid_request` otherwise); a backup code is spent. " +
			"Answers the session bundle with `totp` or `backup_code` appended to the first factor's `amr`, the session lifetime (`remember`) and `next` of the first step. " +
			"A wrong code answers `invalid_code`; a token allows 5 attempts and the fifth wrong one answers `too_many_attempts` and deletes it, so the sign-in starts over. " +
			"An unknown, expired (5 minutes) or used token answers `invalid_token`. The pre-auth token is not a JWT and no other endpoint accepts it.",
		Tags: []string{server.TagAuth},
	}, CodeInvalidRequest, CodeInvalidCode, CodeInvalidToken, CodeTooManyAttempts, CodeInternal), x.exchange)
}

func (x *TwoFactorExchange) exchange(ctx context.Context, in *TwoFactorExchangeInput) (*SignInOutput, error) {
	proof := twofactor.Proof{Code: in.Body.Code, BackupCode: in.Body.BackupCode}
	if (proof.Code == "") == (proof.BackupCode == "") {
		return nil, Err(CodeInvalidRequest)
	}
	raw := in.Body.PreAuthToken
	pre, err := x.deps.PreAuth.Attempt(ctx, raw, PreAuthMaxAttempts)
	switch {
	case err == nil:
	case errors.Is(err, ErrPreAuthNotFound):
		return nil, Err(CodeInvalidToken)
	default:
		x.logger.ErrorContext(ctx, "2fa exchange: load pre-auth", "error", err)
		return nil, Err(CodeInternal)
	}

	user, factor, err := x.deps.TwoFactor.SignIn(ctx, pre.UserID, proof)
	switch {
	case err == nil:
	case errors.Is(err, twofactor.ErrInvalidCode), errors.Is(err, twofactor.ErrNotEnabled):
		code := CodeInvalidCode
		if pre.Attempts >= PreAuthMaxAttempts {
			code = CodeTooManyAttempts
			x.drop(ctx, raw)
		}
		return nil, x.fail(ctx, pre.UserID, proof, code)
	case errors.Is(err, twofactor.ErrUserNotFound):
		x.drop(ctx, raw)
		return nil, Err(CodeInvalidToken)
	case errors.Is(err, twofactor.ErrProofRequired):
		return nil, Err(CodeInvalidRequest)
	case errors.Is(err, idkeys.ErrDecrypt):
		x.logger.ErrorContext(ctx, "2fa exchange: cannot decrypt stored TOTP secret (wrong key encryption key?)", "user_id", pre.UserID)
		return nil, Err(CodeInternal)
	default:
		x.logger.ErrorContext(ctx, "2fa exchange: check second factor", "error", err, "user_id", pre.UserID)
		return nil, Err(CodeInternal)
	}

	// The token is single use: of two concurrent exchanges only the one
	// that deletes it signs in.
	deleted, err := x.deps.PreAuth.Delete(ctx, raw)
	if err != nil {
		x.logger.ErrorContext(ctx, "2fa exchange: delete pre-auth", "error", err, "user_id", user.ID)
		return nil, Err(CodeInternal)
	}
	if !deleted {
		return nil, Err(CodeInvalidToken)
	}

	amr := append(slices.Clone(pre.AMR), factor)
	t, err := x.deps.Sessions.Create(ctx, user, pre.Remember, session.Meta{AMR: amr})
	if err != nil {
		x.logger.ErrorContext(ctx, "2fa exchange: create session", "error", err, "user_id", user.ID)
		return nil, Err(CodeInternal)
	}
	// The session exists: bookkeeping failures below are logged, not
	// returned.
	if err := x.deps.Users.TouchLastLogin(ctx, user.ID); err != nil {
		x.logger.ErrorContext(ctx, "2fa exchange: touch last login", "error", err, "user_id", user.ID)
	}
	if err := x.deps.Audit.Record(ctx, audit.Event{
		User:  &user.ID,
		Actor: &user.ID,
		Kind:  audit.LoginSucceeded,
		Meta: map[string]any{
			"method":        firstFactor(pre.AMR),
			"second_factor": factor,
			"amr":           amr,
			"session_id":    t.Session.ID.String(),
			"remember":      pre.Remember,
		},
	}); err != nil {
		x.logger.ErrorContext(ctx, "2fa exchange: audit", "error", err, "user_id", user.ID)
	}
	return &SignInOutput{Body: NewSignInSession(t, pre.Next, x.now())}, nil
}

// firstFactor names the first factor of amr in audit metadata.
func firstFactor(amr []string) string {
	if len(amr) == 0 {
		return ""
	}
	return amr[0]
}

// drop deletes a pre-auth token that can no longer sign in. A failure is
// logged: the token still expires on its own.
func (x *TwoFactorExchange) drop(ctx context.Context, raw string) {
	if _, err := x.deps.PreAuth.Delete(ctx, raw); err != nil {
		x.logger.ErrorContext(ctx, "2fa exchange: delete pre-auth", "error", err)
	}
}

// fail audits login.failed for user's wrong second factor and returns the
// problem for code.
func (x *TwoFactorExchange) fail(ctx context.Context, user uuid.UUID, p twofactor.Proof, code ErrCode) error {
	method := token.AMRTOTP
	if p.Code == "" {
		method = token.AMRBackupCode
	}
	if err := x.deps.Audit.Record(ctx, audit.Event{
		User: &user,
		Kind: audit.LoginFailed,
		Meta: map[string]any{"method": method, "reason": string(code)},
	}); err != nil {
		x.logger.ErrorContext(ctx, "2fa exchange: audit", "error", err, "user_id", user)
	}
	return Err(code)
}
