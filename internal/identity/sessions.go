package identity

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// MySessionsPath is the sessions list of the signed-in user.
const MySessionsPath = server.APIPrefix + "/users/me/sessions"

// SessionService rotates, ends, lists and revokes refresh-token sessions;
// *session.Service satisfies it.
type SessionService interface {
	Refresh(ctx context.Context, raw string) (session.Tokens, error)
	Logout(ctx context.Context, raw string) error
	List(ctx context.Context, user, currentSID uuid.UUID) ([]session.Active, error)
	Revoke(ctx context.Context, user, id uuid.UUID) error
	RevokeOthers(ctx context.Context, user, currentSID uuid.UUID) (int64, error)
	LogoutAll(ctx context.Context, user uuid.UUID) (int64, error)
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

// SessionInfo is one live session in the sessions list.
type SessionInfo struct {
	ID          string    `json:"id" format:"uuid" doc:"Session id. It changes on every refresh."`
	DeviceLabel string    `json:"device_label" doc:"Device name derived from the user agent at sign-in, e.g. \"Chrome on macOS\"."`
	UserAgent   string    `json:"user_agent" doc:"User agent of the last sign-in or refresh, at most 512 characters."`
	IP          *string   `json:"ip" nullable:"true" doc:"Client IP address of the last sign-in or refresh, or null when unknown."`
	AMR         []string  `json:"amr" doc:"How the session was authenticated."`
	CreatedAt   time.Time `json:"created_at" doc:"When the user signed in."`
	LastSeenAt  time.Time `json:"last_seen_at" doc:"When the session was last used."`
	ExpiresAt   time.Time `json:"expires_at" doc:"When the session ends unless refreshed."`
	Current     bool      `json:"current" doc:"True for the session the request was made with."`
}

// NewSessionInfo renders a.
func NewSessionInfo(a session.Active) SessionInfo {
	info := SessionInfo{
		ID:          a.ID.String(),
		DeviceLabel: a.DeviceLabel,
		UserAgent:   a.UserAgent,
		AMR:         a.Amr,
		CreatedAt:   a.CreatedAt,
		LastSeenAt:  a.LastSeenAt,
		ExpiresAt:   a.ExpiresAt,
		Current:     a.Current,
	}
	if info.AMR == nil {
		info.AMR = []string{}
	}
	if a.Ip != nil {
		ip := a.Ip.String()
		info.IP = &ip
	}
	return info
}

// ListMySessionsOutput is the response of GET /api/v1/users/me/sessions.
type ListMySessionsOutput struct {
	Body struct {
		Sessions []SessionInfo `json:"sessions" doc:"Live sessions, most recently active first."`
	}
}

// RevokeMySessionInput is the request of DELETE
// /api/v1/users/me/sessions/{id}.
type RevokeMySessionInput struct {
	ID string `path:"id" format:"uuid" doc:"Session id from the sessions list."`
}

// RevokeOtherSessionsOutput is the response of POST
// /api/v1/users/me/sessions/revoke-others.
type RevokeOtherSessionsOutput struct {
	Body struct {
		Revoked int64 `json:"revoked" minimum:"0" doc:"How many sessions were signed out."`
	}
}

// Sessions serves the refresh, logout, sessions-list and revocation
// endpoints.
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

// Register mounts POST /api/v1/auth/refresh, POST /api/v1/auth/logout,
// POST /api/v1/auth/logout-all, GET /api/v1/users/me/sessions,
// DELETE /api/v1/users/me/sessions/{id} and
// POST /api/v1/users/me/sessions/revoke-others. All but the first two
// require a session: install authn.Middleware on api first.
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

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "list-my-sessions",
		Method:      http.MethodGet,
		Path:        MySessionsPath,
		Summary:     "List my sessions",
		Description: "Lists the signed-in user's live sessions (one per sign-in), most recently active first, with device label, IP and activity times. The session the request was made with has `current: true`.",
		Tags:        []string{server.TagUsers},
		Security:    []map[string][]string{{authn.SchemeSession: {}}},
	}, CodeUnauthenticated, CodeInternal), s.listMine)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "revoke-my-session",
		Method:        http.MethodDelete,
		Path:          MySessionsPath + "/{id}",
		Summary:       "Sign out a session",
		Description:   "Ends one of the signed-in user's sessions (it may be the current one): its refresh token stops working at once and its access tokens within seconds. Audited as `session.revoked`. Answers 204 also for an unknown or already ended session.",
		Tags:          []string{server.TagUsers},
		Security:      []map[string][]string{{authn.SchemeSession: {}}},
		DefaultStatus: http.StatusNoContent,
	}, CodeInvalidRequest, CodeUnauthenticated, CodeInternal), s.revokeMine)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "revoke-other-sessions",
		Method:      http.MethodPost,
		Path:        MySessionsPath + "/revoke-others",
		Summary:     "Sign out other sessions",
		Description: "Ends every session of the signed-in user except the one the request was made with: their refresh tokens stop working at once and their access tokens within seconds. Audited as `session.revoked`.",
		Tags:        []string{server.TagUsers},
		Security:    []map[string][]string{{authn.SchemeSession: {}}},
	}, CodeUnauthenticated, CodeSessionExpired, CodeInternal), s.revokeOthers)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "logout-all",
		Method:        http.MethodPost,
		Path:          AuthPrefix + "/logout-all",
		Summary:       "Sign out everywhere",
		Description:   "Ends every session of the signed-in user, including the current one: refresh tokens stop working at once and access tokens within seconds. Audited as `session.revoked`.",
		Tags:          []string{server.TagAuth},
		Security:      []map[string][]string{{authn.SchemeSession: {}}},
		DefaultStatus: http.StatusNoContent,
	}, CodeUnauthenticated, CodeInternal), s.logoutAll)
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

func (s *Sessions) listMine(ctx context.Context, _ *struct{}) (*ListMySessionsOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	list, err := s.svc.List(ctx, p.UserID, p.SessionID)
	if err != nil {
		s.logger.ErrorContext(ctx, "list sessions", "error", err)
		return nil, Err(CodeInternal)
	}
	out := &ListMySessionsOutput{}
	out.Body.Sessions = make([]SessionInfo, len(list))
	for i, a := range list {
		out.Body.Sessions[i] = NewSessionInfo(a)
	}
	return out, nil
}

func (s *Sessions) revokeMine(ctx context.Context, in *RevokeMySessionInput) (*struct{}, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		// Unreachable: the path parameter is validated as a uuid.
		return nil, Err(CodeInvalidRequest)
	}
	if err := s.svc.Revoke(ctx, p.UserID, id); err != nil {
		s.logger.ErrorContext(ctx, "revoke session", "error", err)
		return nil, Err(CodeInternal)
	}
	return nil, nil
}

func (s *Sessions) revokeOthers(ctx context.Context, _ *struct{}) (*RevokeOtherSessionsOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	n, err := s.svc.RevokeOthers(ctx, p.UserID, p.SessionID)
	switch {
	case err == nil:
	case errors.Is(err, session.ErrExpired):
		return nil, Err(CodeSessionExpired)
	default:
		s.logger.ErrorContext(ctx, "revoke other sessions", "error", err)
		return nil, Err(CodeInternal)
	}
	out := &RevokeOtherSessionsOutput{}
	out.Body.Revoked = n
	return out, nil
}

func (s *Sessions) logoutAll(ctx context.Context, _ *struct{}) (*struct{}, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	if _, err := s.svc.LogoutAll(ctx, p.UserID); err != nil {
		s.logger.ErrorContext(ctx, "logout all", "error", err)
		return nil, Err(CodeInternal)
	}
	return nil, nil
}
