package oidcprovider

import (
	"context"
	"errors"
	"net/url"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

var (
	// ErrRequestNotFound means the authorization request is unknown, has
	// expired or was already answered.
	ErrRequestNotFound = errors.New("oidcprovider: authorization request not found")
	// ErrReauthRequired means the client asked for a sign-in more recent
	// than the session's (max_age, prompt=login).
	ErrReauthRequired = errors.New("oidcprovider: a more recent sign-in is required")
	// ErrSessionNotFound means the session in the access token is gone.
	ErrSessionNotFound = errors.New("oidcprovider: session not found")
)

// maxAgeLeeway absorbs the seconds between a fresh sign-in and the UI
// completing the request.
const maxAgeLeeway = 5 * time.Second

// Request is what the UI shows while signing a user in for a client.
type Request struct {
	ID          uuid.UUID
	ClientID    string
	ClientName  string
	Scopes      []string
	Prompt      []string
	MaxAge      *int32
	LoginHint   string
	ExpiresAt   time.Time
	CallbackURL string
}

// Request returns the pending authorization request id.
func (s *Storage) Request(ctx context.Context, id uuid.UUID) (Request, error) {
	row, err := s.q.GetOAuthAuthRequest(ctx, id)
	if err != nil {
		return Request{}, requestErr(err)
	}
	if row.UserID != nil {
		return Request{}, ErrRequestNotFound
	}
	c, err := s.q.GetOAuthClient(ctx, row.ClientID)
	if err != nil {
		return Request{}, requestErr(err)
	}
	return Request{
		ID: row.ID, ClientID: c.ID, ClientName: c.Name, Scopes: slices.Clone(row.Scopes),
		Prompt: slices.Clone(row.Prompt), MaxAge: row.MaxAgeSeconds, LoginHint: row.LoginHint,
		ExpiresAt: row.ExpiresAt, CallbackURL: s.CallbackURL(row.ID),
	}, nil
}

// Complete binds the signed-in user (from their session) to authorization
// request id and returns the callback URL the browser must open to send the
// code to the client. The authentication time is when the session signed
// in, so max_age (and prompt=login, which op turns into max_age=0) is
// checked against it.
func (s *Storage) Complete(ctx context.Context, id, userID, sessionID uuid.UUID, amr []string) (string, error) {
	row, err := s.q.GetOAuthAuthRequest(ctx, id)
	if err != nil {
		return "", requestErr(err)
	}
	if row.UserID != nil {
		return "", ErrRequestNotFound
	}
	sess, err := s.q.GetSessionForUser(ctx, db.GetSessionForUserParams{ID: sessionID, UserID: userID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrSessionNotFound
		}
		return "", err
	}
	if sess.RevokedAt != nil {
		return "", ErrSessionNotFound
	}
	authTime := sess.CreatedAt.UTC().Truncate(time.Second)
	if row.MaxAgeSeconds != nil {
		limit := time.Duration(*row.MaxAgeSeconds)*time.Second + maxAgeLeeway
		if s.now().Sub(authTime) > limit {
			return "", ErrReauthRequired
		}
	}
	if _, err := s.q.CompleteOAuthAuthRequest(ctx, db.CompleteOAuthAuthRequestParams{
		ID: id, UserID: &userID, Amr: nonNil(slices.Clone(amr)), AuthTime: &authTime,
	}); err != nil {
		return "", requestErr(err)
	}
	return s.CallbackURL(id), nil
}

// CallbackURL is where the browser returns to identity for request id.
func (s *Storage) CallbackURL(id uuid.UUID) string {
	return s.opts.Issuer + CallbackPath + "?" + url.Values{"id": {id.String()}}.Encode()
}

func requestErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRequestNotFound
	}
	return err
}
