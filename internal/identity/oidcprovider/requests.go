package oidcprovider

import (
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// authRequest is a stored authorization request (op.AuthRequest).
type authRequest struct {
	row db.OauthAuthRequest
}

var _ op.AuthRequest = (*authRequest)(nil)

func (a *authRequest) GetID() string    { return a.row.ID.String() }
func (a *authRequest) GetACR() string   { return "" }
func (a *authRequest) GetAMR() []string { return slices.Clone(a.row.Amr) }

// GetAudience is the client alone: tokens a client gets on a user's behalf
// are not (yet) accepted by the APILens API.
func (a *authRequest) GetAudience() []string { return []string{a.row.ClientID} }

func (a *authRequest) GetAuthTime() time.Time {
	if a.row.AuthTime == nil {
		return time.Time{}
	}
	return *a.row.AuthTime
}

func (a *authRequest) GetClientID() string { return a.row.ClientID }

func (a *authRequest) GetCodeChallenge() *oidc.CodeChallenge {
	if a.row.CodeChallenge == "" {
		return nil
	}
	return &oidc.CodeChallenge{Challenge: a.row.CodeChallenge, Method: oidc.CodeChallengeMethod(a.row.CodeChallengeMethod)}
}

func (a *authRequest) GetNonce() string       { return a.row.Nonce }
func (a *authRequest) GetRedirectURI() string { return a.row.RedirectUri }
func (a *authRequest) GetResponseType() oidc.ResponseType {
	return oidc.ResponseType(a.row.ResponseType)
}
func (a *authRequest) GetResponseMode() oidc.ResponseMode {
	return oidc.ResponseMode(a.row.ResponseMode)
}
func (a *authRequest) GetScopes() []string { return slices.Clone(a.row.Scopes) }
func (a *authRequest) GetState() string    { return a.row.State }

func (a *authRequest) GetSubject() string {
	if a.row.UserID == nil {
		return ""
	}
	return a.row.UserID.String()
}

// Done reports whether the user signed in through the UI.
func (a *authRequest) Done() bool { return a.row.UserID != nil }

// LogValue keeps state, nonce and the PKCE challenge out of logs.
func (a *authRequest) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("id", a.row.ID.String()),
		slog.String("client_id", a.row.ClientID),
		slog.String("response_type", a.row.ResponseType),
		slog.Any("scopes", a.row.Scopes),
		slog.Bool("done", a.Done()),
	)
}

// refreshRequest is the grant behind a refresh token (op.RefreshTokenRequest).
type refreshRequest struct {
	row    db.OauthToken
	scopes []string
}

var _ op.RefreshTokenRequest = (*refreshRequest)(nil)

func (r *refreshRequest) GetAMR() []string      { return slices.Clone(r.row.Amr) }
func (r *refreshRequest) GetAudience() []string { return slices.Clone(r.row.Audience) }
func (r *refreshRequest) GetAuthTime() time.Time {
	if r.row.AuthTime == nil {
		return time.Time{}
	}
	return *r.row.AuthTime
}
func (r *refreshRequest) GetClientID() string              { return r.row.ClientID }
func (r *refreshRequest) GetScopes() []string              { return slices.Clone(r.scopes) }
func (r *refreshRequest) SetCurrentScopes(scopes []string) { r.scopes = slices.Clone(scopes) }

func (r *refreshRequest) GetSubject() string {
	if r.row.UserID == nil {
		return ""
	}
	return r.row.UserID.String()
}

// clientRequest is a client_credentials grant: the client acts for itself.
type clientRequest struct {
	clientID string
	scopes   []string
}

var _ op.TokenRequest = (*clientRequest)(nil)

func (c *clientRequest) GetSubject() string    { return c.clientID }
func (c *clientRequest) GetAudience() []string { return []string{Audience} }
func (c *clientRequest) GetScopes() []string   { return slices.Clone(c.scopes) }

// grant is what an issued token records about the request behind it.
type grant struct {
	clientID string
	userID   *uuid.UUID
	scopes   []string
	audience []string
	amr      []string
	authTime *time.Time
}

// grantOf extracts the grant of the token requests this provider supports.
func grantOf(req op.TokenRequest) (grant, bool) {
	switch r := req.(type) {
	case *authRequest:
		return grant{
			clientID: r.row.ClientID, userID: r.row.UserID, scopes: r.GetScopes(),
			audience: r.GetAudience(), amr: r.GetAMR(), authTime: r.row.AuthTime,
		}, true
	case *refreshRequest:
		return grant{
			clientID: r.row.ClientID, userID: r.row.UserID, scopes: r.GetScopes(),
			audience: r.GetAudience(), amr: r.GetAMR(), authTime: r.row.AuthTime,
		}, true
	case *clientRequest:
		return grant{clientID: r.clientID, scopes: r.GetScopes(), audience: r.GetAudience()}, true
	default:
		return grant{}, false
	}
}

// nonNil returns s, or an empty slice for a NOT NULL array column.
func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
