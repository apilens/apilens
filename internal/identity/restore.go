package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// RestorePath restores a deleted account inside its grace period.
const RestorePath = MePath + "/restore"

// CodeVerifier checks a typed email code and consumes it;
// *emailauth.Service satisfies it.
type CodeVerifier interface {
	VerifyCode(ctx context.Context, email, code string) (db.AuthEmailToken, error)
}

// AccountRestorer restores a deleted account; *account.Service satisfies it.
type AccountRestorer interface {
	Restore(ctx context.Context, email string) (db.User, error)
}

// RestoreBody is the request body of POST /api/v1/users/me/restore.
type RestoreBody struct {
	Email string `json:"email" format:"email" minLength:"3" maxLength:"320" doc:"Address of the deleted account."`
	Code  string `json:"code" minLength:"1" maxLength:"32" doc:"A fresh 6-digit code emailed to the address."`
}

// RestoreInput is the request of POST /api/v1/users/me/restore.
type RestoreInput struct {
	Body RestoreBody
}

// RestoreOutput is the response of POST /api/v1/users/me/restore.
type RestoreOutput struct {
	Body struct {
		User AuthUser `json:"user"`
	}
}

// Restore serves POST /api/v1/users/me/restore.
type Restore struct {
	accounts AccountRestorer
	codes    CodeVerifier
	limiter  *ratelimit.Limiter
	perEmail ratelimit.Rate
	logger   *slog.Logger
}

// NewRestore returns the restore endpoint. limiter enforces
// identity.rate_limits.code_verify_per_email, like every code check.
func NewRestore(cfg config.IdentityConfig, accounts AccountRestorer, codes CodeVerifier, limiter *ratelimit.Limiter, logger *slog.Logger) *Restore {
	return &Restore{
		accounts: accounts,
		codes:    codes,
		limiter:  limiter,
		perEmail: ratelimit.Rate(cfg.RateLimits.CodeVerifyPerEmail),
		logger:   logger,
	}
}

// Register mounts POST /api/v1/users/me/restore.
func (r *Restore) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "restore-me",
		Method:      http.MethodPost,
		Path:        RestorePath,
		Summary:     "Restore a deleted account",
		Description: "Public; authenticated by a fresh email code sent to the account's address. " +
			"Undoes `DELETE /api/v1/users/me` while the account is inside its grace period (sign-in answers `account_deleting` with `delete_after` until then). " +
			"No session is issued: sign in again afterwards. Audited as `user.restored`. " +
			"A wrong code, an address with nothing to restore, and an account past its grace period all answer `invalid_code`. " +
			"Rate-limited per email address.",
		Tags: []string{server.TagUsers},
	}, CodeInvalidCode, CodeCodeExpired, CodeTooManyAttempts, CodeRateLimited, CodeInternal), r.restore)
}

func (r *Restore) restore(ctx context.Context, in *RestoreInput) (*RestoreOutput, error) {
	addr := strings.ToLower(strings.TrimSpace(in.Body.Email))
	// Shares the code-verify bucket, so restore adds no guesses to sign-in's.
	res, err := r.limiter.Allow(ctx, "code_verify:email", addr, r.perEmail)
	if err != nil {
		r.logger.ErrorContext(ctx, "restore account: rate limiter unavailable; refusing", "error", err)
		return nil, huma.Error503ServiceUnavailable("rate limiter unavailable, retry later")
	}
	if !res.Allowed {
		return nil, ErrRetryAfter(CodeRateLimited, res.RetryAfter)
	}
	if _, err := r.codes.VerifyCode(ctx, addr, in.Body.Code); err != nil {
		switch {
		case errors.Is(err, emailauth.ErrInvalidCode):
			return nil, Err(CodeInvalidCode)
		case errors.Is(err, emailauth.ErrCodeExpired):
			return nil, Err(CodeCodeExpired)
		case errors.Is(err, emailauth.ErrTooManyAttempts):
			return nil, Err(CodeTooManyAttempts)
		default:
			r.logger.ErrorContext(ctx, "restore account: verify code", "error", err)
			return nil, Err(CodeInternal)
		}
	}
	u, err := r.accounts.Restore(ctx, addr)
	switch {
	case err == nil:
		out := &RestoreOutput{}
		out.Body.User = NewAuthUser(u)
		return out, nil
	case errors.Is(err, account.ErrNotFound):
		return nil, Err(CodeInvalidCode)
	default:
		r.logger.ErrorContext(ctx, "restore account", "error", err)
		return nil, Err(CodeInternal)
	}
}
