package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/emailchange"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the email change of the signed-in user.
const (
	EmailChangePath  = MePath + "/email/change"
	EmailConfirmPath = MePath + "/email/confirm"
)

// EmailChangeService starts and confirms email changes;
// *emailchange.Service satisfies it.
type EmailChangeService interface {
	Start(ctx context.Context, id uuid.UUID, newEmail string) (emailchange.Pending, error)
	Confirm(ctx context.Context, id, currentSession uuid.UUID, code string) (db.User, error)
}

// EmailChangeInput is the request of POST /api/v1/users/me/email/change.
type EmailChangeInput struct {
	Body struct {
		NewEmail string `json:"new_email" format:"email" minLength:"3" maxLength:"254" doc:"Address to move the account to. A code is emailed to it."`
	}
}

// EmailChangeOutput is the response of POST /api/v1/users/me/email/change.
type EmailChangeOutput struct {
	Body struct {
		PendingEmail string    `json:"pending_email" format:"email" doc:"The address the confirmation code was sent to."`
		ExpiresAt    time.Time `json:"expires_at" doc:"When the code stops working."`
	}
}

// EmailConfirmInput is the request of POST /api/v1/users/me/email/confirm.
type EmailConfirmInput struct {
	Body struct {
		Code string `json:"code" minLength:"1" maxLength:"64" doc:"The 6-digit code emailed to the new address; spaces and hyphens are ignored."`
	}
}

// EmailChange serves POST /api/v1/users/me/email/change and /confirm.
type EmailChange struct {
	svc    EmailChangeService
	logger *slog.Logger
}

// NewEmailChange returns the email change endpoints over svc.
func NewEmailChange(svc EmailChangeService, logger *slog.Logger) *EmailChange {
	return &EmailChange{svc: svc, logger: logger}
}

// Register mounts the email change operations. They declare the session
// scheme, so authn.Middleware must be installed on api before.
func (e *EmailChange) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "start-email-change",
		Method:        http.MethodPost,
		Path:          EmailChangePath,
		DefaultStatus: http.StatusAccepted,
		Summary:       "Start changing the signed-in user's email",
		Description:   "Emails a 6-digit code to `new_email`; confirm it with `/users/me/email/confirm`. A new request replaces the pending one. Answers `email_taken` when another account uses the address, and `invalid_request` when it is already the user's.",
		Tags:          []string{server.TagUsers},
		Security:      security,
	}, CodeInvalidRequest, CodeEmailTaken, CodeUnauthenticated, CodeSessionExpired, CodeInternal), e.start)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "confirm-email-change",
		Method:      http.MethodPost,
		Path:        EmailConfirmPath,
		Summary:     "Confirm the signed-in user's new email",
		Description: "Checks the code sent to the new address and makes it the account's verified email. Every other session is signed out and the old address gets a security alert. Audited as `email.changed`.",
		Tags:        []string{server.TagUsers},
		Security:    security,
	}, CodeInvalidCode, CodeCodeExpired, CodeTooManyAttempts, CodeEmailTaken, CodeUnauthenticated, CodeSessionExpired, CodeInternal), e.confirm)
}

func (e *EmailChange) start(ctx context.Context, in *EmailChangeInput) (*EmailChangeOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	pending, err := e.svc.Start(ctx, p.UserID, in.Body.NewEmail)
	if err != nil {
		return nil, e.fail(ctx, "start email change", err)
	}
	out := &EmailChangeOutput{}
	out.Body.PendingEmail = pending.Email
	out.Body.ExpiresAt = pending.ExpiresAt.UTC()
	return out, nil
}

func (e *EmailChange) confirm(ctx context.Context, in *EmailConfirmInput) (*MeOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	u, err := e.svc.Confirm(ctx, p.UserID, p.SessionID, in.Body.Code)
	if err != nil {
		return nil, e.fail(ctx, "confirm email change", err)
	}
	return &MeOutput{Body: NewMe(u, p.AMR)}, nil
}

// fail maps a service error to its problem. A user (or session) gone while
// the access token is still valid answers session_expired.
func (e *EmailChange) fail(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, emailchange.ErrNotFound):
		return Err(CodeSessionExpired)
	case errors.Is(err, emailchange.ErrEmailTaken):
		return Err(CodeEmailTaken)
	case errors.Is(err, emailchange.ErrSameEmail):
		return Err(CodeInvalidRequest)
	case errors.Is(err, emailauth.ErrInvalidCode):
		return Err(CodeInvalidCode)
	case errors.Is(err, emailauth.ErrCodeExpired):
		return Err(CodeCodeExpired)
	case errors.Is(err, emailauth.ErrTooManyAttempts):
		return Err(CodeTooManyAttempts)
	default:
		e.logger.ErrorContext(ctx, op, "error", err)
		return Err(CodeInternal)
	}
}
