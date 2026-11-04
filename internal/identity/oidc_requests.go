package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/oidcprovider"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// OIDCRequestsPath is the path of a pending authorization request of the
// built-in OpenID provider.
const OIDCRequestsPath = AuthPrefix + "/oidc/requests/{id}"

// OIDCRequestStore reads and completes authorization requests;
// *oidcprovider.Storage satisfies it.
type OIDCRequestStore interface {
	Request(ctx context.Context, id uuid.UUID) (oidcprovider.Request, error)
	Complete(ctx context.Context, id, userID, sessionID uuid.UUID, amr []string) (string, error)
}

// OIDCRequestInput names an authorization request.
type OIDCRequestInput struct {
	ID string `path:"id" format:"uuid" doc:"The request_id the UI sign-in page received."`
}

// OIDCRequest is a pending authorization request as the UI shows it.
type OIDCRequest struct {
	ID          string    `json:"id" format:"uuid"`
	ClientID    string    `json:"client_id" doc:"The client asking for the sign-in."`
	ClientName  string    `json:"client_name" doc:"Display name of the client (may be empty)."`
	Scopes      []string  `json:"scopes" doc:"Scopes requested (openid, profile, email, offline_access)."`
	Prompt      []string  `json:"prompt" doc:"The client's prompt values. With \"none\" the UI must not show a sign-in: if no one is signed in it sends the browser to callback_url with error=login_required."`
	MaxAge      *int32    `json:"max_age,omitempty" doc:"Maximum age in seconds of the sign-in; prompt=login is sent as 0."`
	LoginHint   string    `json:"login_hint,omitempty" doc:"Email the client suggests signing in with."`
	ExpiresAt   time.Time `json:"expires_at"`
	CallbackURL string    `json:"callback_url" format:"uri" doc:"Identity's callback for this request. Append error=login_required (or access_denied, interaction_required) to end the request without signing in."`
}

// OIDCRequestOutput is the response of GET /api/v1/auth/oidc/requests/{id}.
type OIDCRequestOutput struct {
	Body OIDCRequest
}

// OIDCCompleteOutput is the response of POST …/complete.
type OIDCCompleteOutput struct {
	Body struct {
		RedirectTo string `json:"redirect_to" format:"uri" doc:"Navigate the browser here; identity sends the authorization code on to the client."`
	}
}

// OIDCRequests serves the authorization-request endpoints the UI sign-in
// page uses for the built-in OpenID provider.
type OIDCRequests struct {
	store  OIDCRequestStore
	logger *slog.Logger
}

// NewOIDCRequests returns the authorization-request endpoints over store.
func NewOIDCRequests(store OIDCRequestStore, logger *slog.Logger) *OIDCRequests {
	return &OIDCRequests{store: store, logger: logger}
}

// Register mounts GET /api/v1/auth/oidc/requests/{id} and POST …/complete.
// The latter declares the session scheme, so authn.Middleware must be
// installed on api before.
func (o *OIDCRequests) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "get-oidc-request",
		Method:      http.MethodGet,
		Path:        OIDCRequestsPath,
		Summary:     "Get a pending OpenID authorization request",
		Description: "Public; the request id is the capability. The UI sign-in page (`/auth/oidc?request_id=`) reads which client asks for a sign-in and how (`prompt`, `max_age`). " +
			"Answers `invalid_request` once the request has expired (10 minutes) or was answered. Only served when `identity.oidc_provider.enabled` is set.",
		Tags: []string{server.TagAuth},
	}, CodeInvalidRequest, CodeInternal), o.get)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "complete-oidc-request",
		Method:        http.MethodPost,
		Path:          OIDCRequestsPath + "/complete",
		Summary:       "Sign the current user in to an OpenID client",
		Description:   "Binds the signed-in user to the authorization request and returns the identity callback URL to navigate to; it sends the authorization code on to the client. The authentication time is the session's sign-in time: when it is older than the request's `max_age` (or `prompt=login` was asked) it answers `reauth_required`, and the user must sign in again first.",
		Tags:          []string{server.TagAuth},
		Security:      []map[string][]string{{authn.SchemeSession: {}}},
		DefaultStatus: http.StatusOK,
	}, CodeInvalidRequest, CodeReauthRequired, CodeUnauthenticated, CodeSessionExpired, CodeInternal), o.complete)
}

func (o *OIDCRequests) get(ctx context.Context, in *OIDCRequestInput) (*OIDCRequestOutput, error) {
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, Err(CodeInvalidRequest)
	}
	r, err := o.store.Request(ctx, id)
	if err != nil {
		return nil, o.fail(ctx, "get oidc request", err)
	}
	return &OIDCRequestOutput{Body: OIDCRequest{
		ID: r.ID.String(), ClientID: r.ClientID, ClientName: r.ClientName,
		Scopes: nonEmpty(r.Scopes), Prompt: nonEmpty(r.Prompt), MaxAge: r.MaxAge,
		LoginHint: r.LoginHint, ExpiresAt: r.ExpiresAt.UTC(), CallbackURL: r.CallbackURL,
	}}, nil
}

func (o *OIDCRequests) complete(ctx context.Context, in *OIDCRequestInput) (*OIDCCompleteOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, Err(CodeInvalidRequest)
	}
	to, err := o.store.Complete(ctx, id, p.UserID, p.SessionID, p.AMR)
	if err != nil {
		return nil, o.fail(ctx, "complete oidc request", err)
	}
	out := &OIDCCompleteOutput{}
	out.Body.RedirectTo = to
	return out, nil
}

func (o *OIDCRequests) fail(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, oidcprovider.ErrRequestNotFound):
		return Err(CodeInvalidRequest)
	case errors.Is(err, oidcprovider.ErrReauthRequired):
		return Err(CodeReauthRequired)
	case errors.Is(err, oidcprovider.ErrSessionNotFound):
		return Err(CodeSessionExpired)
	default:
		o.logger.ErrorContext(ctx, op, "error", err)
		return Err(CodeInternal)
	}
}

func nonEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return slices.Clone(s)
}
