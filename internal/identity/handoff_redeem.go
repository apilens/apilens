package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// HandoffBody is the request body of POST /api/v1/auth/handoff.
type HandoffBody struct {
	Code string `json:"code" minLength:"1" maxLength:"256" doc:"The one-time code from the {public_ui_url}/auth/callback?code=… redirect of a Google, GitHub or SSO sign-in."`
}

// HandoffInput is the request of POST /api/v1/auth/handoff.
type HandoffInput struct {
	Body HandoffBody
}

// Handoff serves POST /api/v1/auth/handoff: the UI's /auth/callback Route
// Handler redeems the one-time code a browser sign-in redirected with for
// the stored sign-in answer.
type Handoff struct {
	store   HandoffStore
	limiter *ratelimit.Limiter
	perIP   ratelimit.Rate
	logger  *slog.Logger
}

// NewHandoff returns the handoff endpoint. limiter enforces
// identity.rate_limits.handoff_per_ip.
func NewHandoff(cfg config.IdentityConfig, store HandoffStore, limiter *ratelimit.Limiter, logger *slog.Logger) *Handoff {
	return &Handoff{
		store:   store,
		limiter: limiter,
		perIP:   ratelimit.Rate(cfg.RateLimits.HandoffPerIP),
		logger:  logger,
	}
}

// Register mounts POST /api/v1/auth/handoff.
func (h *Handoff) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "redeem-handoff",
		Method:      http.MethodPost,
		Path:        AuthPrefix + "/handoff",
		Summary:     "Redeem a one-time sign-in handoff code",
		Description: "Public. After a Google, GitHub or SSO sign-in the browser lands on `{public_ui_url}/auth/callback?code=…`; the UI's server side posts that code here. " +
			"Answers what the sign-in produced: the session bundle or, when the user has two-factor authentication enabled, `{status: \"2fa_required\", pre_auth_token}`, either with the `next` path the sign-in started with. " +
			"The code is deleted as it is read (atomic GETDEL), so it works once: an unknown, expired (60 s) or already redeemed code answers `invalid_token`. " +
			"Rate-limited per client IP (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{h.limiter.Limit(api, "handoff", h.perIP, ratelimit.Key{})},
	}, CodeInvalidToken, CodeRateLimited, CodeInternal), h.redeem)
}

func (h *Handoff) redeem(ctx context.Context, in *HandoffInput) (*SignInOutput, error) {
	res, err := h.store.Take(ctx, in.Body.Code)
	switch {
	case errors.Is(err, ErrHandoffNotFound):
		return nil, Err(CodeInvalidToken)
	case err != nil:
		h.logger.ErrorContext(ctx, "handoff: redeem code", "error", err)
		return nil, Err(CodeInternal)
	}
	return &SignInOutput{Body: res}, nil
}
