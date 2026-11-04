package identity

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/platform/server"
)

// The magic link of a sign-in email lands on the UI ({public_ui_url}/verify
// ?token=…&email=…), whose server side exchanges the token at POST
// /api/v1/auth/email/verify-link. GET /api/v1/auth/email/link only bounces a
// browser that reached identity directly to that UI page.
//
// The link token is a bearer secret: it is never logged, audited or echoed
// in a problem. Only its hash is stored (see package emailauth).

// EmailVerifyLinkBody is the request body of POST
// /api/v1/auth/email/verify-link.
type EmailVerifyLinkBody struct {
	Token    string `json:"token" minLength:"1" maxLength:"128" doc:"The token from the magic link (its token query parameter)."`
	Remember bool   `json:"remember,omitempty" doc:"Keep the session for identity.refresh_token_ttl (30 days) instead of identity.refresh_token_ttl_short (24 hours)."`
}

// EmailVerifyLinkInput is the request of POST /api/v1/auth/email/verify-link.
type EmailVerifyLinkInput struct {
	Body EmailVerifyLinkBody
}

// EmailLinkInput is the request of GET /api/v1/auth/email/link.
type EmailLinkInput struct {
	Token string `query:"token" required:"true" minLength:"1" maxLength:"128" doc:"The token from the magic link."`
	Email string `query:"email" maxLength:"254" doc:"The address the link was emailed to, passed on to the UI."`
}

// EmailLinkOutput redirects the browser to the UI's verify page.
type EmailLinkOutput struct {
	Status       int
	Location     string `header:"Location" doc:"{public_ui_url}/verify with the token (and email) query parameters."`
	CacheControl string `header:"Cache-Control"`
	Referrer     string `header:"Referrer-Policy"`
}

func (e *EmailVerify) registerLink(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "verify-email-link",
		Method:      http.MethodPost,
		Path:        AuthPrefix + "/email/verify-link",
		Summary:     "Sign in with an emailed magic link",
		Description: "Public; called by the UI's server side with the token of a magic link it was opened with. " +
			"Checks the token and consumes the email, so the link (and its code) work once. " +
			"The user is found or, on first sign-in, created, and the address is marked verified. " +
			"Answers the session bundle (`amr: [\"email\"]`; `remember` picks the session lifetime) or, " +
			"when the user has two-factor authentication enabled, `{status: \"2fa_required\", pre_auth_token}`. " +
			"Either answer carries the `next` path the email was requested with. " +
			"An unknown, used or superseded link answers `invalid_token`; an expired one `code_expired`.",
		Tags: []string{server.TagAuth},
	}, CodeInvalidToken, CodeCodeExpired, CodeInternal), e.verifyLink)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "open-email-link",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/email/link",
		Summary:     "Open an emailed magic link",
		Description: "Public browser navigation, for clients that open a magic link on identity rather than on the UI. " +
			"Redirects (302) to `{public_ui_url}/verify?token=…` (with `email` when given) without checking or consuming the token; " +
			"the UI then exchanges it at `POST /api/v1/auth/email/verify-link`.",
		Tags:          []string{server.TagAuth},
		DefaultStatus: http.StatusFound,
	}), e.openLink)
}

func (e *EmailVerify) verifyLink(ctx context.Context, in *EmailVerifyLinkInput) (*SignInOutput, error) {
	row, err := e.deps.Codes.VerifyLink(ctx, in.Body.Token)
	switch {
	case err == nil:
	case errors.Is(err, emailauth.ErrInvalidLink):
		return nil, e.failLink(ctx, CodeInvalidToken)
	case errors.Is(err, emailauth.ErrLinkExpired):
		return nil, e.failLink(ctx, CodeCodeExpired)
	default:
		e.logger.ErrorContext(ctx, "email verify link: verify link", "error", err)
		return nil, Err(CodeInternal)
	}
	if !signInIntent(row) {
		return nil, e.failLink(ctx, CodeInvalidToken)
	}
	return e.signIn(ctx, row.Email, row, in.Body.Remember, "email verify link")
}

// failLink audits login.failed and returns the problem for code. A failed
// link names no address, and the token itself is never recorded.
func (e *EmailVerify) failLink(ctx context.Context, code ErrCode) error {
	if err := e.deps.Audit.Record(ctx, audit.Event{
		Kind: audit.LoginFailed,
		Meta: map[string]any{"method": "email_link", "reason": string(code)},
	}); err != nil {
		e.logger.ErrorContext(ctx, "email verify link: audit", "error", err)
	}
	return Err(code)
}

func (e *EmailVerify) openLink(_ context.Context, in *EmailLinkInput) (*EmailLinkOutput, error) {
	q := url.Values{"token": {in.Token}}
	if in.Email != "" {
		q.Set("email", in.Email)
	}
	return &EmailLinkOutput{
		Status:       http.StatusFound,
		Location:     e.uiURL + "/verify?" + q.Encode(),
		CacheControl: "no-store",
		// The token rides in the URL: keep it out of Referer headers.
		Referrer: "no-referrer",
	}, nil
}
