package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/identity/recovery"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// RecoveryPrefix is the path prefix of the account recovery endpoints.
const RecoveryPrefix = AuthPrefix + "/recovery"

// RecoveryService runs account recovery; *recovery.Service satisfies it.
type RecoveryService interface {
	Request(ctx context.Context, email string) error
	Status(ctx context.Context, token string) (recovery.Status, error)
	Confirm(ctx context.Context, token string) (db.User, error)
	Cancel(ctx context.Context, token string) error
}

// RecoveryRequestInput is the request of POST /api/v1/auth/recovery/request.
type RecoveryRequestInput struct {
	Body struct {
		Email string `json:"email" format:"email" minLength:"3" maxLength:"254" doc:"Address of the account whose two-factor device was lost."`
	}
}

// RecoveryRequestOutput is the response of POST
// /api/v1/auth/recovery/request.
type RecoveryRequestOutput struct {
	Body struct {
		Sent bool `json:"sent" doc:"Always true; the response never reveals whether an account exists or has two-factor authentication on."`
	}
}

// RecoveryTokenBody carries the token from a recovery email.
type RecoveryTokenBody struct {
	Token string `json:"token" minLength:"1" maxLength:"128" doc:"Token from the recovery email's link."`
}

// RecoveryTokenInput is the request of POST /api/v1/auth/recovery/confirm
// and /cancel.
type RecoveryTokenInput struct {
	Body RecoveryTokenBody
}

// RecoveryStatusInput is the request of GET /api/v1/auth/recovery/status.
type RecoveryStatusInput struct {
	Token string `query:"token" required:"true" minLength:"1" maxLength:"128" doc:"Token from the recovery email's link."`
}

// RecoveryStatusOutput is the response of GET /api/v1/auth/recovery/status.
type RecoveryStatusOutput struct {
	Body struct {
		Status      string    `json:"status" enum:"pending,ready,confirmed,cancelled" doc:"pending: waiting out the cooling-off period; ready: it can be confirmed; confirmed: recovery completed; cancelled: cancelled or replaced by a newer request."`
		RequestedAt time.Time `json:"requested_at" doc:"When recovery was requested."`
		ReadyAt     time.Time `json:"ready_at" doc:"When the cooling-off period ends and recovery can be confirmed."`
	}
}

// RecoveryConfirmOutput is the response of POST
// /api/v1/auth/recovery/confirm.
type RecoveryConfirmOutput struct {
	Body TokenResponse
}

// Recovery serves the account recovery endpoints (two-factor device lost).
type Recovery struct {
	svc      RecoveryService
	sessions SessionCreator
	limiter  *ratelimit.Limiter
	perIP    ratelimit.Rate
	perEmail ratelimit.Rate
	logger   *slog.Logger
	now      func() time.Time
}

// NewRecovery returns the recovery endpoints over svc, starting the session
// of a confirmed recovery with sessions. limiter enforces
// identity.rate_limits.recovery_per_ip on every endpoint and
// recovery_request_per_email on request.
func NewRecovery(cfg config.IdentityConfig, svc RecoveryService, sessions SessionCreator, limiter *ratelimit.Limiter, logger *slog.Logger) *Recovery {
	return &Recovery{
		svc:      svc,
		sessions: sessions,
		limiter:  limiter,
		perIP:    ratelimit.Rate(cfg.RateLimits.RecoveryPerIP),
		perEmail: ratelimit.Rate(cfg.RateLimits.RecoveryRequestPerEmail),
		logger:   logger,
		now:      time.Now,
	}
}

// Register mounts POST /api/v1/auth/recovery/request, GET
// /api/v1/auth/recovery/status, POST /api/v1/auth/recovery/confirm and POST
// /api/v1/auth/recovery/cancel. All are public.
func (r *Recovery) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "request-account-recovery",
		Method:      http.MethodPost,
		Path:        RecoveryPrefix + "/request",
		Summary:     "Request account recovery",
		Description: "Public. For an account whose two-factor device was lost: when the address has an active account with two-factor authentication on, " +
			"starts a recovery request and emails `recovery_requested` with a cancel link. The request can be confirmed only after `identity.recovery_delay` (24 hours); " +
			"a newer request replaces older pending ones. Always answers 200 `{sent: true}`, whether or not such an account exists. " +
			"Audited as `recovery.requested`. Rate-limited per client IP and per email address (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{r.limiter.Limit(api, "recovery_request", r.perIP, ratelimit.Key{})},
	}, CodeInvalidRequest, CodeRateLimited, CodeInternal), r.request)

	limit := huma.Middlewares{r.limiter.Limit(api, "recovery_token", r.perIP, ratelimit.Key{})}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "get-account-recovery-status",
		Method:      http.MethodGet,
		Path:        RecoveryPrefix + "/status",
		Summary:     "Get account recovery status",
		Description: "Public; authenticated by the token from the recovery email. Answers the request's state and when it was requested and becomes ready. " +
			"An unknown token answers `invalid_token`. Rate-limited per client IP.",
		Tags:        []string{server.TagAuth},
		Middlewares: limit,
	}, CodeInvalidToken, CodeRateLimited, CodeInternal), r.status)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "confirm-account-recovery",
		Method:      http.MethodPost,
		Path:        RecoveryPrefix + "/confirm",
		Summary:     "Confirm account recovery",
		Description: "Public; authenticated by the token from the recovery email. Allowed only once the cooling-off period has passed (`recovery_not_ready` with `retry_after` before). " +
			"Turns two-factor authentication off (deletes the secret and every backup code), signs out every session and emails a `security_change` alert, " +
			"then answers a fresh session (`amr: [\"email\"]`). Audited as `recovery.confirmed` and `totp.disabled`. " +
			"An unknown, cancelled or already confirmed token answers `invalid_token`. Rate-limited per client IP.",
		Tags:        []string{server.TagAuth},
		Middlewares: limit,
	}, CodeInvalidToken, CodeRecoveryNotReady, CodeRateLimited, CodeInternal), r.confirm)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "cancel-account-recovery",
		Method:        http.MethodPost,
		Path:          RecoveryPrefix + "/cancel",
		DefaultStatus: http.StatusNoContent,
		Summary:       "Cancel account recovery",
		Description: "Public; authenticated by the token from the recovery email. Cancels a pending request; cancelling one already cancelled also answers 204. " +
			"Audited as `recovery.cancelled`. An unknown or already confirmed token answers `invalid_token`. Rate-limited per client IP.",
		Tags:        []string{server.TagAuth},
		Middlewares: limit,
	}, CodeInvalidToken, CodeRateLimited, CodeInternal), r.cancel)
}

func (r *Recovery) request(ctx context.Context, in *RecoveryRequestInput) (*RecoveryRequestOutput, error) {
	addr, ok := NormalizeEmail(in.Body.Email)
	if !ok {
		return nil, Err(CodeInvalidRequest)
	}
	res, err := r.limiter.Allow(ctx, "recovery_request:email", addr, r.perEmail)
	if err != nil {
		r.logger.ErrorContext(ctx, "recovery request: rate limiter unavailable; refusing", "error", err)
		return nil, huma.Error503ServiceUnavailable("rate limiter unavailable, retry later")
	}
	if !res.Allowed {
		return nil, ErrRetryAfter(CodeRateLimited, res.RetryAfter)
	}
	if err := r.svc.Request(ctx, addr); err != nil {
		r.logger.ErrorContext(ctx, "recovery request", "error", err)
		return nil, Err(CodeInternal)
	}
	out := &RecoveryRequestOutput{}
	out.Body.Sent = true
	return out, nil
}

func (r *Recovery) status(ctx context.Context, in *RecoveryStatusInput) (*RecoveryStatusOutput, error) {
	st, err := r.svc.Status(ctx, in.Token)
	if err != nil {
		return nil, r.fail(ctx, "recovery status", err)
	}
	out := &RecoveryStatusOutput{}
	out.Body.Status = string(st.State)
	out.Body.RequestedAt = st.RequestedAt.UTC()
	out.Body.ReadyAt = st.ReadyAt.UTC()
	return out, nil
}

func (r *Recovery) confirm(ctx context.Context, in *RecoveryTokenInput) (*RecoveryConfirmOutput, error) {
	user, err := r.svc.Confirm(ctx, in.Body.Token)
	if err != nil {
		return nil, r.fail(ctx, "recovery confirm", err)
	}
	t, err := r.sessions.Create(ctx, user, false, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		// Recovery is done: 2FA is off, so the user can sign in by email.
		r.logger.ErrorContext(ctx, "recovery confirm: create session", "error", err, "user_id", user.ID)
		return nil, Err(CodeInternal)
	}
	return &RecoveryConfirmOutput{Body: NewTokenResponse(t, r.now())}, nil
}

func (r *Recovery) cancel(ctx context.Context, in *RecoveryTokenInput) (*struct{}, error) {
	if err := r.svc.Cancel(ctx, in.Body.Token); err != nil {
		return nil, r.fail(ctx, "recovery cancel", err)
	}
	return nil, nil
}

// fail maps a service error to its problem.
func (r *Recovery) fail(ctx context.Context, op string, err error) error {
	var notReady *recovery.NotReadyError
	switch {
	case errors.Is(err, recovery.ErrInvalidToken):
		return Err(CodeInvalidToken)
	case errors.As(err, &notReady):
		return ErrRetryAfter(CodeRecoveryNotReady, notReady.Wait)
	default:
		r.logger.ErrorContext(ctx, op, "error", err)
		return Err(CodeInternal)
	}
}
