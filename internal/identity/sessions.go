package identity

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// SessionService rotates and ends refresh-token sessions;
// *session.Service satisfies it.
type SessionService interface {
	Refresh(ctx context.Context, raw string) (session.Tokens, error)
	Logout(ctx context.Context, raw string) error
}

// AuthUser is the signed-in user as returned with every token response.
type AuthUser struct {
	ID            string `json:"id" format:"uuid" doc:"User id; the access token's sub."`
	Email         string `json:"email" format:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	AvatarURL     string `json:"avatar_url"`
}

// TokenResponse is the body every sign-in method and refresh returns.
type TokenResponse struct {
	AccessToken  string   `json:"access_token" doc:"RS256 access token (JWT); send it as a bearer token."`
	RefreshToken string   `json:"refresh_token" doc:"Opaque refresh token. It is single-use: every refresh returns a new one, and presenting a used one again revokes the session."`
	ExpiresIn    int      `json:"expires_in" minimum:"1" doc:"Seconds until the access token expires."`
	User         AuthUser `json:"user"`
}

// NewTokenResponse renders t, with expires_in counted from now.
func NewTokenResponse(t session.Tokens, now time.Time) TokenResponse {
	return TokenResponse{
		AccessToken:  t.AccessToken,
		RefreshToken: t.RefreshToken,
		ExpiresIn:    max(1, int(math.Ceil(t.AccessExpiresAt.Sub(now).Seconds()))),
		User:         NewAuthUser(t.User),
	}
}

// NewAuthUser renders u.
func NewAuthUser(u db.User) AuthUser {
	return AuthUser{
		ID:            u.ID.String(),
		Email:         u.Email,
		EmailVerified: u.EmailVerifiedAt != nil,
		Name:          u.Name,
		AvatarURL:     u.AvatarUrl,
	}
}

// RefreshTokenBody carries a refresh token.
type RefreshTokenBody struct {
	RefreshToken string `json:"refresh_token" minLength:"1" maxLength:"512" doc:"The refresh token from the last sign-in or refresh."`
}

// RefreshInput is the request of POST /api/v1/auth/refresh.
type RefreshInput struct {
	Body RefreshTokenBody
}

// RefreshOutput is the response of POST /api/v1/auth/refresh.
type RefreshOutput struct {
	Body TokenResponse
}

// LogoutInput is the request of POST /api/v1/auth/logout.
type LogoutInput struct {
	Body RefreshTokenBody
}

// Sessions serves the refresh and logout endpoints.
type Sessions struct {
	svc     SessionService
	limiter *ratelimit.Limiter
	limit   ratelimit.Rate
	logger  *slog.Logger
	now     func() time.Time
}

// NewSessions returns the session endpoints over svc. limiter enforces
// identity.rate_limits.refresh_per_ip on refresh.
func NewSessions(cfg config.IdentityConfig, svc SessionService, limiter *ratelimit.Limiter, logger *slog.Logger) *Sessions {
	return &Sessions{
		svc:     svc,
		limiter: limiter,
		limit:   ratelimit.Rate(cfg.RateLimits.RefreshPerIP),
		logger:  logger,
		now:     time.Now,
	}
}

// Register mounts POST /api/v1/auth/refresh and POST /api/v1/auth/logout.
func (s *Sessions) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "refresh-session",
		Method:      http.MethodPost,
		Path:        AuthPrefix + "/refresh",
		Summary:     "Refresh the session",
		Description: "Public; authenticated by the refresh token in the body. Rotates the refresh token and returns a new access token and refresh token. Each refresh token works once: presenting one that was already rotated revokes every session of its sign-in (reuse detection) and answers `invalid_token`. Rate-limited per client IP.",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{s.limiter.Limit(api, "refresh", s.limit, ratelimit.Key{})},
	}, CodeInvalidToken, CodeSessionExpired, CodeRateLimited, CodeInternal), s.refresh)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "logout",
		Method:        http.MethodPost,
		Path:          AuthPrefix + "/logout",
		Summary:       "Sign out",
		Description:   "Public; authenticated by the refresh token in the body. Ends the session the token belongs to. Always answers 204, also for an unknown or already ended token.",
		Tags:          []string{server.TagAuth},
		DefaultStatus: http.StatusNoContent,
	}, CodeInternal), s.logout)
}

func (s *Sessions) refresh(ctx context.Context, in *RefreshInput) (*RefreshOutput, error) {
	t, err := s.svc.Refresh(ctx, in.Body.RefreshToken)
	switch {
	case err == nil:
		return &RefreshOutput{Body: NewTokenResponse(t, s.now())}, nil
	case errors.Is(err, session.ErrInvalidToken):
		return nil, Err(CodeInvalidToken)
	case errors.Is(err, session.ErrExpired):
		return nil, Err(CodeSessionExpired)
	default:
		s.logger.ErrorContext(ctx, "refresh session", "error", err)
		return nil, Err(CodeInternal)
	}
}

func (s *Sessions) logout(ctx context.Context, in *LogoutInput) (*struct{}, error) {
	if err := s.svc.Logout(ctx, in.Body.RefreshToken); err != nil {
		s.logger.ErrorContext(ctx, "logout", "error", err)
		return nil, Err(CodeInternal)
	}
	return nil, nil
}
