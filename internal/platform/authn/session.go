package authn

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Audience is the `aud` identity puts in every access token.
const Audience = "apilens"

// Leeway is the clock skew tolerated on `exp` and `iat`.
const Leeway = 30 * time.Second

var (
	// ErrInvalidToken means the token is malformed, tampered with, signed by
	// an unknown key, or fails a claim check.
	ErrInvalidToken = errors.New("authn: invalid access token")
	// ErrExpired means the token was valid but its `exp` has passed.
	ErrExpired = errors.New("authn: access token expired")
)

// claims mirrors the access token claims (docs/architecture/overview.md,
// "Identity").
type claims struct {
	SessionID string   `json:"sid"`
	AMR       []string `json:"amr"`
	jwt.RegisteredClaims
}

// SessionVerifier verifies access tokens locally against identity's keys.
type SessionVerifier struct {
	keys   KeySource
	issuer string
	now    func() time.Time
}

// NewSessionVerifier returns a verifier accepting tokens with `iss` issuer
// signed by a key from keys. now may be nil (time.Now).
func NewSessionVerifier(keys KeySource, issuer string, now func() time.Time) *SessionVerifier {
	if now == nil {
		now = time.Now
	}
	return &SessionVerifier{keys: keys, issuer: issuer, now: now}
}

// Verify checks raw's RS256 signature and its `iss`, `aud`, `exp`, `iat`,
// `sub`, `sid` and `amr` claims. It fails with ErrExpired, ErrUnavailable
// (keys could not be loaded) or ErrInvalidToken.
func (v *SessionVerifier) Verify(ctx context.Context, raw string) (Principal, error) {
	var c claims
	_, err := jwt.ParseWithClaims(raw, &c, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, ErrUnknownKey
		}
		return v.keys.PublicKey(ctx, kid)
	},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(Audience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(Leeway),
		jwt.WithTimeFunc(v.now),
	)
	switch {
	case err == nil:
	case errors.Is(err, ErrUnavailable):
		return Principal{}, ErrUnavailable
	case errors.Is(err, jwt.ErrTokenExpired):
		return Principal{}, ErrExpired
	default:
		return Principal{}, fmt.Errorf("%w: %w", ErrInvalidToken, err)
	}
	user, err := uuid.Parse(c.Subject)
	if err != nil {
		return Principal{}, fmt.Errorf("%w: sub is not a user id", ErrInvalidToken)
	}
	session, err := uuid.Parse(c.SessionID)
	if err != nil {
		return Principal{}, fmt.Errorf("%w: sid is not a session id", ErrInvalidToken)
	}
	if len(c.AMR) == 0 {
		return Principal{}, fmt.Errorf("%w: amr is empty", ErrInvalidToken)
	}
	return Principal{Kind: KindUser, UserID: user, SessionID: session, AMR: slices.Clone(c.AMR)}, nil
}

// bearer returns the token of an `Authorization: Bearer` header, or "".
func bearer(h string) string {
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// looksLikeJWT reports whether raw has the three segments of a compact JWS.
// API keys never contain dots.
func looksLikeJWT(raw string) bool { return strings.Count(raw, ".") == 2 }

// Middleware authenticates operations that declare SchemeSession and stores
// the user's Principal in the context. Install it before registering the
// operations it should guard, and before middlewares of other schemes.
//
// An operation that also accepts another scheme (an API key) is passed on
// untouched when the bearer is not a JWT, so that scheme's middleware can
// handle it; an operation already carrying a Principal is passed on too.
func Middleware(api huma.API, v *SessionVerifier) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		op := ctx.Operation()
		if !Declares(op, SchemeSession) {
			next(ctx)
			return
		}
		if _, ok := FromContext(ctx.Context()); ok {
			next(ctx)
			return
		}
		raw := bearer(ctx.Header("Authorization"))
		if !looksLikeJWT(raw) && acceptsOtherScheme(op) {
			next(ctx)
			return
		}
		if raw == "" {
			unauthorized(api, ctx, "", "a session is required (Authorization: Bearer <access_token>)")
			return
		}
		p, err := v.Verify(ctx.Context(), raw)
		switch {
		case errors.Is(err, ErrUnavailable):
			ctx.SetHeader("Retry-After", "1")
			_ = huma.WriteErr(api, ctx, http.StatusServiceUnavailable, "authentication backend unavailable, retry later")
		case errors.Is(err, ErrExpired):
			unauthorized(api, ctx, `, error="invalid_token", error_description="token expired"`, "the access token has expired; refresh it")
		case err != nil:
			unauthorized(api, ctx, `, error="invalid_token"`, "the access token is invalid")
		default:
			next(huma.WithContext(ctx, WithPrincipal(ctx.Context(), p)))
		}
	}
}

func acceptsOtherScheme(op *huma.Operation) bool {
	for _, req := range op.Security {
		for name := range req {
			if name != SchemeSession {
				return true
			}
		}
	}
	return false
}

func unauthorized(api huma.API, ctx huma.Context, params, msg string) {
	ctx.SetHeader("WWW-Authenticate", `Bearer realm="apilens"`+params)
	_ = huma.WriteErr(api, ctx, http.StatusUnauthorized, msg)
}
