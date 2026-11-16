// Package token issues and verifies identity's access tokens: short-lived
// RS256 JWTs signed with the active signing key (package keys).
//
// Access tokens live identity.access_token_ttl (15 minutes by default), so
// revoking a session takes effect within one TTL: the next refresh fails and
// no new access token is issued. Verifiers elsewhere (api, query, mcp) check
// them against the published JWKS; identity checks them with Verify.
//
// The claims are documented in docs/architecture/overview.md ("Identity").
package token

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// Audience is the `aud` of every access token.
const Audience = "apilens"

// Leeway is the clock skew tolerated on `exp` and `iat` between identity
// replicas.
const Leeway = 30 * time.Second

// Authentication methods (`amr` values) an access token can carry.
const (
	AMREmail   = "email"
	AMRGoogle  = "google"
	AMRGitHub  = "github"
	AMRPasskey = "passkey"
	AMRTOTP    = "totp"
	// AMRBackupCode: the second factor was a single-use 2FA backup code.
	AMRBackupCode = "backup_code"
	AMRSSO        = "sso"
)

// AMRs lists every valid `amr` value.
var AMRs = []string{AMREmail, AMRGoogle, AMRGitHub, AMRPasskey, AMRTOTP, AMRBackupCode, AMRSSO}

var (
	// ErrInvalid means the token is malformed, tampered with, or fails a
	// claim check. Verify wraps it with the reason.
	ErrInvalid = errors.New("token: invalid")
	// ErrExpired means the token was valid but its `exp` has passed.
	ErrExpired = errors.New("token: expired")
	// ErrUnknownKey means the `kid` header names no published signing key.
	ErrUnknownKey = errors.New("token: unknown signing key")
	// ErrNoActiveKey means no key is active to sign with.
	ErrNoActiveKey = errors.New("token: no active signing key")
)

// KeySource supplies signing keys; *keys.Manager satisfies it.
type KeySource interface {
	Active() (keys.Key, bool)
	All() []keys.Key
}

// Claims are the claims of an access token.
type Claims struct {
	// SessionID (`sid`) is the session the token was issued for.
	SessionID string `json:"sid"`
	// AMR (`amr`, RFC 8176) lists how the user authenticated.
	AMR []string `json:"amr"`
	// AuthTime (`auth_time`, OIDC Core) is when the user signed in to the
	// session: its created_at, kept across refreshes. The API compares it
	// with identity.sensitive_action_max_age (authz.RequireRecentAuth).
	AuthTime *jwt.NumericDate `json:"auth_time,omitempty"`
	jwt.RegisteredClaims
}

// Options configures an Issuer.
type Options struct {
	// Issuer is the `iss` claim: identity.issuer.
	Issuer string
	// TTL is the token lifetime: identity.access_token_ttl.
	TTL time.Duration
	// Now returns the current time. Nil means time.Now.
	Now func() time.Time
}

// Issuer signs and verifies access tokens.
type Issuer struct {
	keys   KeySource
	issuer string
	ttl    time.Duration
	now    func() time.Time
}

// New returns an Issuer that signs with the active key of ks.
func New(ks KeySource, opts Options) (*Issuer, error) {
	if opts.Issuer == "" {
		return nil, errors.New("token: issuer is required")
	}
	if opts.TTL <= 0 {
		return nil, errors.New("token: TTL must be > 0")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Issuer{keys: ks, issuer: opts.Issuer, ttl: opts.TTL, now: opts.Now}, nil
}

// Issue signs an access token for user in session, authenticated by amr.
// It returns the compact JWT and its expiry.
func (i *Issuer) Issue(user db.User, session db.Session, amr []string) (string, time.Time, error) {
	if session.UserID != user.ID {
		return "", time.Time{}, errors.New("token: session belongs to another user")
	}
	if session.RevokedAt != nil {
		return "", time.Time{}, errors.New("token: session is revoked")
	}
	if err := checkAMR(amr); err != nil {
		return "", time.Time{}, err
	}
	key, ok := i.keys.Active()
	if !ok {
		return "", time.Time{}, ErrNoActiveKey
	}
	priv, ok := key.Signer().(*rsa.PrivateKey)
	if !ok {
		return "", time.Time{}, fmt.Errorf("token: key %s is not an RSA key", key.KID)
	}
	now := i.now().Truncate(time.Second)
	exp := now.Add(i.ttl)
	claims := Claims{
		SessionID: session.ID.String(),
		AMR:       slices.Clone(amr),
		AuthTime:  jwt.NewNumericDate(session.CreatedAt.Truncate(time.Second)),
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    i.issuer,
			Subject:   user.ID.String(),
			Audience:  jwt.ClaimStrings{Audience},
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	t.Header["kid"] = key.KID
	signed, err := t.SignedString(priv)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("token: sign: %w", err)
	}
	return signed, exp, nil
}

// Verify checks raw's RS256 signature against the published key its `kid`
// names, and its `iss`, `aud`, `exp`, `iat`, `sub`, `sid` and `amr` claims.
// It fails with ErrExpired, ErrUnknownKey or ErrInvalid.
func (i *Issuer) Verify(raw string) (*Claims, error) {
	var claims Claims
	_, err := jwt.ParseWithClaims(raw, &claims, i.keyFunc,
		jwt.WithValidMethods([]string{keys.AlgRS256}),
		jwt.WithIssuer(i.issuer),
		jwt.WithAudience(Audience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(Leeway),
		jwt.WithTimeFunc(i.now),
	)
	switch {
	case err == nil:
	case errors.Is(err, ErrUnknownKey):
		return nil, ErrUnknownKey
	case errors.Is(err, jwt.ErrTokenExpired):
		return nil, ErrExpired
	default:
		return nil, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if claims.Subject == "" || claims.SessionID == "" {
		return nil, fmt.Errorf("%w: missing sub or sid", ErrInvalid)
	}
	if err := checkAMR(claims.AMR); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	return &claims, nil
}

// keyFunc returns the public key of the published key the token's kid names.
func (i *Issuer) keyFunc(t *jwt.Token) (any, error) {
	kid, _ := t.Header["kid"].(string)
	if kid == "" {
		return nil, ErrUnknownKey
	}
	for _, k := range i.keys.All() {
		if k.KID != kid {
			continue
		}
		if k.Alg != keys.AlgRS256 {
			return nil, fmt.Errorf("token: key %s has alg %q", kid, k.Alg)
		}
		return k.Signer().Public(), nil
	}
	return nil, ErrUnknownKey
}

// checkAMR requires at least one known authentication method.
func checkAMR(amr []string) error {
	if len(amr) == 0 {
		return errors.New("token: amr is empty")
	}
	for _, m := range amr {
		if !slices.Contains(AMRs, m) {
			return fmt.Errorf("token: unknown amr %q", m)
		}
	}
	return nil
}
