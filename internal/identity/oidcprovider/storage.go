package oidcprovider

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// DB is the Postgres handle the storage runs on; *pgxpool.Pool satisfies it.
type DB interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// KeySource supplies the signing keys; *keys.Manager satisfies it.
type KeySource interface {
	Active() (keys.Key, bool)
	All() []keys.Key
}

// Storage implements op.Storage (plus client credentials) on Postgres:
// oauth_clients, oauth_auth_requests and oauth_tokens.
type Storage struct {
	db   DB
	q    *db.Queries
	keys KeySource
	opts Options
}

var (
	_ op.Storage                   = (*Storage)(nil)
	_ op.ClientCredentialsStorage  = (*Storage)(nil)
	_ op.CanSetUserinfoFromRequest = (*Storage)(nil)
)

// NewStorage returns the provider storage over pool, signing with ks.
func NewStorage(pool DB, ks KeySource, opts Options) (*Storage, error) {
	if !strings.HasPrefix(opts.Issuer, "http://") && !strings.HasPrefix(opts.Issuer, "https://") {
		return nil, errors.New("oidcprovider: issuer must be an http(s) URL")
	}
	if opts.AccessTokenTTL <= 0 || opts.RefreshTokenTTL <= 0 {
		return nil, errors.New("oidcprovider: token TTLs must be > 0")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	opts.Issuer = strings.TrimRight(opts.Issuer, "/")
	return &Storage{db: pool, q: db.New(pool), keys: ks, opts: opts}, nil
}

func (s *Storage) now() time.Time { return s.opts.Now().UTC() }

// --------------------------------------------------------------------------
// Authorization requests

// CreateAuthRequest stores a validated authorization request. Only S256 is
// accepted as PKCE method (OAuth 2.1); plain would expose the verifier.
func (s *Storage) CreateAuthRequest(ctx context.Context, req *oidc.AuthRequest, _ string) (op.AuthRequest, error) {
	if req.CodeChallenge != "" && req.CodeChallengeMethod != oidc.CodeChallengeMethodS256 {
		return nil, oidc.ErrInvalidRequest().WithDescription("code_challenge_method must be S256")
	}
	var maxAge *int32
	if req.MaxAge != nil {
		v := int32(min(*req.MaxAge, math.MaxInt32)) //nolint:gosec // G115: clamped above
		maxAge = &v
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	row, err := s.q.CreateOAuthAuthRequest(ctx, db.CreateOAuthAuthRequestParams{
		ID:                  id,
		ClientID:            req.ClientID,
		RedirectUri:         req.RedirectURI,
		Scopes:              nonNil(req.Scopes),
		ResponseType:        string(req.ResponseType),
		ResponseMode:        string(req.ResponseMode),
		State:               req.State,
		Nonce:               req.Nonce,
		CodeChallenge:       req.CodeChallenge,
		CodeChallengeMethod: string(req.CodeChallengeMethod),
		Prompt:              nonNil(req.Prompt),
		MaxAgeSeconds:       maxAge,
		LoginHint:           req.LoginHint,
		ExpiresAt:           s.now().Add(AuthRequestTTL),
	})
	if err != nil {
		return nil, fmt.Errorf("oidcprovider: create auth request: %w", err)
	}
	return &authRequest{row: row}, nil
}

// AuthRequestByID returns an unexpired authorization request.
func (s *Storage) AuthRequestByID(ctx context.Context, id string) (op.AuthRequest, error) {
	rid, err := uuid.Parse(id)
	if err != nil {
		return nil, errNotFound
	}
	row, err := s.q.GetOAuthAuthRequest(ctx, rid)
	if err != nil {
		return nil, notFound(err)
	}
	return &authRequest{row: row}, nil
}

// AuthRequestByCode redeems code: its request is deleted as it is read, so
// a code works at most once.
func (s *Storage) AuthRequestByCode(ctx context.Context, code string) (op.AuthRequest, error) {
	row, err := s.q.ConsumeOAuthAuthCode(ctx, ptr(hashToken(code)))
	if err != nil {
		return nil, notFound(err)
	}
	return &authRequest{row: row}, nil
}

// SaveAuthCode records the code issued for a signed-in request. It fails if
// the request already has one, so a replayed callback issues no second code.
func (s *Storage) SaveAuthCode(ctx context.Context, id, code string) error {
	rid, err := uuid.Parse(id)
	if err != nil {
		return errNotFound
	}
	n, err := s.q.SaveOAuthAuthCode(ctx, db.SaveOAuthAuthCodeParams{
		ID: rid, CodeHash: ptr(hashToken(code)), CodeExpiresAt: s.now().Add(CodeTTL),
	})
	if err != nil {
		return fmt.Errorf("oidcprovider: save code: %w", err)
	}
	if n == 0 {
		return oidc.ErrInvalidRequest().WithDescription("the authorization request was already answered or has expired")
	}
	return nil
}

// DeleteAuthRequest drops a request; one already redeemed is gone already.
func (s *Storage) DeleteAuthRequest(ctx context.Context, id string) error {
	rid, err := uuid.Parse(id)
	if err != nil {
		return nil //nolint:nilerr // nothing stored under a non-UUID id
	}
	return s.q.DeleteOAuthAuthRequest(ctx, rid)
}

// --------------------------------------------------------------------------
// Tokens

// CreateAccessToken records an access token without a refresh token and
// returns its id (the JWT's jti).
func (s *Storage) CreateAccessToken(ctx context.Context, req op.TokenRequest) (string, time.Time, error) {
	g, ok := grantOf(req)
	if !ok {
		return "", time.Time{}, oidc.ErrUnsupportedGrantType()
	}
	row, err := s.insertToken(ctx, s.q, g, nil, nil)
	if err != nil {
		return "", time.Time{}, err
	}
	return row.ID.String(), row.ExpiresAt, nil
}

// CreateAccessAndRefreshTokens records an access token with a new refresh
// token. With currentRefreshToken set this is a refresh: the presented token
// is revoked in the same transaction (rotation), and the new one keeps the
// family's absolute expiry.
func (s *Storage) CreateAccessAndRefreshTokens(ctx context.Context, req op.TokenRequest, currentRefreshToken string) (string, string, time.Time, error) {
	g, ok := grantOf(req)
	if !ok || g.userID == nil {
		return "", "", time.Time{}, oidc.ErrUnsupportedGrantType()
	}
	refresh, err := randomToken(32)
	if err != nil {
		return "", "", time.Time{}, err
	}
	var row db.OauthToken
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		refreshExp := s.now().Add(s.opts.RefreshTokenTTL)
		if currentRefreshToken != "" {
			old, err := q.RevokeOAuthRefreshToken(ctx, ptr(hashToken(currentRefreshToken)))
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return oidc.ErrInvalidGrant().WithDescription("the refresh token is invalid or was already used")
				}
				return err
			}
			if old.RefreshExpiresAt != nil {
				refreshExp = *old.RefreshExpiresAt
			}
		}
		var err error
		row, err = s.insertToken(ctx, q, g, ptr(hashToken(refresh)), &refreshExp)
		return err
	})
	if err != nil {
		return "", "", time.Time{}, err
	}
	return row.ID.String(), refresh, row.ExpiresAt, nil
}

func (s *Storage) insertToken(ctx context.Context, q *db.Queries, g grant, refreshHash *string, refreshExp *time.Time) (db.OauthToken, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return db.OauthToken{}, err
	}
	row, err := q.CreateOAuthToken(ctx, db.CreateOAuthTokenParams{
		ID:               id,
		ClientID:         g.clientID,
		UserID:           g.userID,
		Scopes:           nonNil(g.scopes),
		Audience:         nonNil(g.audience),
		Amr:              nonNil(g.amr),
		AuthTime:         g.authTime,
		ExpiresAt:        s.now().Add(s.opts.AccessTokenTTL).Truncate(time.Second),
		RefreshTokenHash: refreshHash,
		RefreshExpiresAt: refreshExp,
	})
	if err != nil {
		return db.OauthToken{}, fmt.Errorf("oidcprovider: create token: %w", err)
	}
	return row, nil
}

// TokenRequestByRefreshToken returns the grant behind a live refresh token
// of a user who still exists.
func (s *Storage) TokenRequestByRefreshToken(ctx context.Context, refreshToken string) (op.RefreshTokenRequest, error) {
	row, err := s.q.GetOAuthTokenByRefreshHash(ctx, ptr(hashToken(refreshToken)))
	if err != nil {
		return nil, notFound(err)
	}
	if row.UserID == nil {
		return nil, errNotFound
	}
	if _, err := s.q.GetUserByID(ctx, *row.UserID); err != nil {
		return nil, notFound(err)
	}
	return &refreshRequest{row: row, scopes: slices.Clone(row.Scopes)}, nil
}

// TerminateSession signs userID out of clientID: every token it holds for
// them is revoked.
func (s *Storage) TerminateSession(ctx context.Context, userID, clientID string) error {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return nil //nolint:nilerr // no tokens are stored for a non-user subject
	}
	_, err = s.q.RevokeOAuthTokensForUserClient(ctx, db.RevokeOAuthTokensForUserClientParams{UserID: &uid, ClientID: clientID})
	return err
}

// RevokeToken revokes a token (by its id, as op resolves both access and
// refresh tokens to it) of clientID. Unknown tokens are not an error
// (RFC 7009 §2.2).
func (s *Storage) RevokeToken(ctx context.Context, tokenOrTokenID, _, clientID string) *oidc.Error {
	id, err := uuid.Parse(tokenOrTokenID)
	if err != nil {
		return nil //nolint:nilerr // not one of our token ids: nothing to revoke
	}
	if _, err := s.q.RevokeOAuthToken(ctx, db.RevokeOAuthTokenParams{ID: id, ClientID: clientID}); err != nil {
		return oidc.ErrServerError().WithParent(err)
	}
	return nil
}

// GetRefreshTokenInfo resolves a refresh token of clientID to its user and
// token id.
func (s *Storage) GetRefreshTokenInfo(ctx context.Context, clientID, token string) (string, string, error) {
	row, err := s.q.GetOAuthTokenByRefreshHash(ctx, ptr(hashToken(token)))
	if err != nil || row.ClientID != clientID || row.UserID == nil {
		return "", "", op.ErrInvalidRefreshToken
	}
	return row.UserID.String(), row.ID.String(), nil
}

// --------------------------------------------------------------------------
// Keys

// SigningKey is the active signing key.
func (s *Storage) SigningKey(context.Context) (op.SigningKey, error) {
	k, ok := s.keys.Active()
	if !ok {
		return nil, errors.New("oidcprovider: no active signing key")
	}
	return signingKey{k}, nil
}

// SignatureAlgorithms: identity signs with RS256 only.
func (s *Storage) SignatureAlgorithms(context.Context) ([]jose.SignatureAlgorithm, error) {
	return []jose.SignatureAlgorithm{jose.RS256}, nil
}

// KeySet is every published key, for verifying our own tokens (userinfo,
// id_token_hint).
func (s *Storage) KeySet(context.Context) ([]op.Key, error) {
	all := s.keys.All()
	out := make([]op.Key, 0, len(all))
	for _, k := range all {
		if k.Alg == keys.AlgRS256 {
			out = append(out, publicKey{k})
		}
	}
	return out, nil
}

type signingKey struct{ k keys.Key }

func (k signingKey) SignatureAlgorithm() jose.SignatureAlgorithm { return jose.RS256 }
func (k signingKey) Key() any                                    { return k.k.Signer() }
func (k signingKey) ID() string                                  { return k.k.KID }

type publicKey struct{ k keys.Key }

func (k publicKey) ID() string                         { return k.k.KID }
func (k publicKey) Algorithm() jose.SignatureAlgorithm { return jose.RS256 }
func (k publicKey) Use() string                        { return "sig" }
func (k publicKey) Key() any                           { return k.k.Signer().Public() }

// --------------------------------------------------------------------------
// Clients

// GetClientByClientID returns an active client.
func (s *Storage) GetClientByClientID(ctx context.Context, clientID string) (op.Client, error) {
	row, err := s.q.GetOAuthClient(ctx, clientID)
	if err != nil {
		return nil, notFound(err)
	}
	return s.client(row), nil
}

func (s *Storage) client(row db.OauthClient) *client {
	return &client{
		row:        row,
		loginURL:   strings.TrimRight(s.opts.PublicUIURL, "/") + LoginPath,
		idTokenTTL: s.opts.AccessTokenTTL,
	}
}

// AuthorizeClientIDSecret checks a confidential client's secret.
func (s *Storage) AuthorizeClientIDSecret(ctx context.Context, clientID, clientSecret string) error {
	row, err := s.q.GetOAuthClient(ctx, clientID)
	if err != nil {
		return notFound(err)
	}
	if !checkSecret(row, clientSecret) {
		return errors.New("oidcprovider: wrong client secret")
	}
	return nil
}

// ClientCredentials authenticates a client for the client_credentials grant.
func (s *Storage) ClientCredentials(ctx context.Context, clientID, clientSecret string) (op.Client, error) {
	row, err := s.q.GetOAuthClient(ctx, clientID)
	if err != nil || !checkSecret(row, clientSecret) {
		return nil, oidc.ErrInvalidClient().WithDescription("invalid client_id / client_secret")
	}
	return s.client(row), nil
}

// ClientCredentialsTokenRequest is the grant of a client acting for itself.
// No API scopes exist yet (M4), so none are granted.
func (s *Storage) ClientCredentialsTokenRequest(_ context.Context, clientID string, _ []string) (op.TokenRequest, error) {
	return &clientRequest{clientID: clientID, scopes: []string{}}, nil
}

// --------------------------------------------------------------------------
// Claims

// SetUserinfoFromScopes is deprecated in op; SetUserinfoFromRequest is used.
func (s *Storage) SetUserinfoFromScopes(context.Context, *oidc.UserInfo, string, string, []string) error {
	return nil
}

// SetUserinfoFromRequest fills the ID token's user claims.
func (s *Storage) SetUserinfoFromRequest(ctx context.Context, info *oidc.UserInfo, req op.IDTokenRequest, scopes []string) error {
	return s.fillUser(ctx, info, req.GetSubject(), scopes)
}

// SetUserinfoFromToken answers /oauth/userinfo for a live access token
// issued on a user's behalf.
func (s *Storage) SetUserinfoFromToken(ctx context.Context, info *oidc.UserInfo, tokenID, subject, _ string) error {
	row, err := s.activeToken(ctx, tokenID)
	if err != nil {
		return err
	}
	if row.UserID == nil || row.UserID.String() != subject {
		return errors.New("oidcprovider: token was not issued for a user")
	}
	return s.fillUser(ctx, info, subject, row.Scopes)
}

// SetIntrospectionFromToken describes a live token to the client it was
// issued to or for.
func (s *Storage) SetIntrospectionFromToken(ctx context.Context, resp *oidc.IntrospectionResponse, tokenID, subject, clientID string) error {
	row, err := s.activeToken(ctx, tokenID)
	if err != nil {
		return err
	}
	if row.ClientID != clientID && !slices.Contains(row.Audience, clientID) {
		return errors.New("oidcprovider: token belongs to another client")
	}
	resp.Scope = row.Scopes
	resp.ClientID = row.ClientID
	resp.TokenType = oidc.BearerToken
	resp.Expiration = oidc.FromTime(row.ExpiresAt)
	resp.IssuedAt = oidc.FromTime(row.CreatedAt)
	resp.Subject = subject
	resp.Audience = row.Audience
	resp.Issuer = s.opts.Issuer
	resp.JWTID = row.ID.String()
	if row.AuthTime != nil {
		resp.AuthTime = oidc.FromTime(*row.AuthTime)
	}
	if len(row.Amr) > 0 {
		resp.AuthenticationMethodsReferences = row.Amr
	}
	if row.UserID != nil {
		var info oidc.UserInfo
		if err := s.fillUser(ctx, &info, row.UserID.String(), row.Scopes); err != nil {
			return err
		}
		resp.SetUserInfo(&info)
	}
	return nil
}

// GetPrivateClaimsFromScopes: no private claims yet.
func (s *Storage) GetPrivateClaimsFromScopes(context.Context, string, string, []string) (map[string]any, error) {
	return nil, nil //nolint:nilnil // no claims, no error
}

// GetKeyByIDAndClientID: private_key_jwt and the JWT bearer grant are not
// supported.
func (s *Storage) GetKeyByIDAndClientID(context.Context, string, string) (*jose.JSONWebKey, error) {
	return nil, errors.New("oidcprovider: client keys are not supported")
}

// ValidateJWTProfileScopes: the JWT bearer grant is not supported.
func (s *Storage) ValidateJWTProfileScopes(context.Context, string, []string) ([]string, error) {
	return nil, oidc.ErrUnsupportedGrantType()
}

// Health pings Postgres.
func (s *Storage) Health(ctx context.Context) error {
	_, err := s.db.Exec(ctx, "SELECT 1")
	return err
}

func (s *Storage) activeToken(ctx context.Context, tokenID string) (db.OauthToken, error) {
	id, err := uuid.Parse(tokenID)
	if err != nil {
		return db.OauthToken{}, errNotFound
	}
	row, err := s.q.GetActiveOAuthToken(ctx, id)
	if err != nil {
		return db.OauthToken{}, notFound(err)
	}
	return row, nil
}

// fillUser sets the claims of the user subject that scopes release.
func (s *Storage) fillUser(ctx context.Context, info *oidc.UserInfo, subject string, scopes []string) error {
	uid, err := uuid.Parse(subject)
	if err != nil {
		return errNotFound
	}
	u, err := s.q.GetUserByID(ctx, uid)
	if err != nil {
		return notFound(err)
	}
	info.Subject = u.ID.String()
	if slices.Contains(scopes, oidc.ScopeProfile) {
		info.Name = u.Name
		info.Picture = u.AvatarUrl
		info.UpdatedAt = oidc.FromTime(u.UpdatedAt)
	}
	if slices.Contains(scopes, oidc.ScopeEmail) {
		info.Email = u.Email
		info.EmailVerified = oidc.Bool(u.EmailVerifiedAt != nil)
	}
	return nil
}

// notFound maps pgx.ErrNoRows to errNotFound and wraps other errors.
func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	return fmt.Errorf("oidcprovider: %w", err)
}

func ptr[T any](v T) *T { return &v }
