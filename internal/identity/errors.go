package identity

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// ErrCode is the stable, machine-readable identifier of an identity failure.
// It is sent as the `code` extension member of an RFC 9457 problem. The UI
// maps it to copy, so a code never changes once shipped; the human-readable
// title and detail may.
//
// Codes are deliberately coarse: none of them reveals whether an email
// address, user or organization exists. "No such account" and "wrong code"
// both answer invalid_code, and the magic-link request always succeeds.
type ErrCode string

// The identity error catalogue. docs/architecture/identity.md documents each
// code's HTTP status and UI copy; keep the two in lock-step (a test checks).
const (
	// CodeInvalidRequest: the request is well formed JSON but semantically
	// unusable (missing redirect, unsupported flow). Schema validation
	// failures are Huma's own 422 problems and carry no code.
	CodeInvalidRequest ErrCode = "invalid_request"
	// CodeInvalidCode: the one-time email code or magic link is wrong, or no
	// account matches. Also returned for an unknown email, by design.
	CodeInvalidCode ErrCode = "invalid_code"
	// CodeCodeExpired: the submitted one-time code matched but has expired.
	CodeCodeExpired ErrCode = "code_expired"
	// CodeTooManyAttempts: too many wrong guesses for one challenge; the
	// challenge is burned and a new code must be requested.
	CodeTooManyAttempts ErrCode = "too_many_attempts"
	// CodeRateLimited: the caller (IP or email bucket) exceeded a rate limit.
	CodeRateLimited ErrCode = "rate_limited"
	// CodeUnauthenticated: no session or bearer token was presented.
	CodeUnauthenticated ErrCode = "unauthenticated"
	// CodeInvalidToken: a bearer, refresh, verification or invite token is
	// malformed, revoked, reused or unknown.
	CodeInvalidToken ErrCode = "invalid_token"
	// CodeSessionExpired: the session existed but has expired or was ended.
	CodeSessionExpired ErrCode = "session_expired"
	// CodeTwoFactorRequired: the first factor succeeded; a TOTP or passkey
	// step is needed before a session is issued.
	CodeTwoFactorRequired ErrCode = "two_factor_required"
	// CodeInvalidTOTP: the TOTP or recovery code is wrong.
	CodeInvalidTOTP ErrCode = "invalid_totp"
	// CodePasskeyUnknown: the WebAuthn assertion names a credential that is
	// not registered (or was removed).
	CodePasskeyUnknown ErrCode = "passkey_unknown"
	// CodePasskeyFailed: the WebAuthn ceremony failed verification
	// (challenge, origin, signature or counter).
	CodePasskeyFailed ErrCode = "passkey_failed"
	// CodePasskeyExists: the passkey being registered is already registered
	// (to this or another account).
	CodePasskeyExists ErrCode = "passkey_already_registered"
	// CodeOAuthStateMismatch: the OAuth/OIDC callback state or PKCE verifier
	// does not match the login attempt.
	CodeOAuthStateMismatch ErrCode = "oauth_state_mismatch"
	// CodeOAuthEmailUnverified: the external provider did not assert a
	// verified email, so it cannot be linked to an account.
	CodeOAuthEmailUnverified ErrCode = "oauth_email_unverified"
	// CodeInviteExpired: the invitation was valid but has expired or was
	// revoked.
	CodeInviteExpired ErrCode = "invite_expired"
	// CodeInviteEmailMismatch: the signed-in user's email differs from the
	// address the invitation was sent to.
	CodeInviteEmailMismatch ErrCode = "invite_email_mismatch"
	// CodeOwnerTransferRequired: the user is the only owner of an
	// organization and must transfer ownership before deleting the account.
	CodeOwnerTransferRequired ErrCode = "owner_transfer_required"
	// CodeAlreadyEnabled: two-factor authentication is already on; turn it
	// off before enabling it again.
	CodeAlreadyEnabled ErrCode = "already_enabled"
	// CodeReauthRequired: the action needs a recent sign-in and the session
	// signed in too long ago; sign in again, then retry.
	CodeReauthRequired ErrCode = "reauth_required"
	// CodeEmailTaken: another account uses the address. Only answered to a
	// signed-in user changing their own email, never on sign-in or sign-up.
	CodeEmailTaken ErrCode = "email_taken"
	// CodeForbidden: authenticated, but not allowed to perform the action.
	CodeForbidden ErrCode = "forbidden"
	// CodeInternal: an unexpected server failure. Details stay in the logs.
	CodeInternal ErrCode = "internal_error"
)

// catalogueEntry is the fixed HTTP status, title and detail of one code. The
// detail is static on purpose: handlers cannot pass request-specific text,
// so no problem can echo an email address or say whether it exists.
type catalogueEntry struct {
	status int
	title  string
	detail string
}

var catalogue = map[ErrCode]catalogueEntry{
	CodeInvalidRequest:        {http.StatusBadRequest, "Invalid request", "The request cannot be processed."},
	CodeInvalidCode:           {http.StatusBadRequest, "Invalid code", "The code is incorrect."},
	CodeCodeExpired:           {http.StatusBadRequest, "Code expired", "The code has expired. Request a new one."},
	CodeTooManyAttempts:       {http.StatusTooManyRequests, "Too many attempts", "Too many incorrect attempts. Request a new code."},
	CodeRateLimited:           {http.StatusTooManyRequests, "Rate limited", "Too many requests. Try again later."},
	CodeUnauthenticated:       {http.StatusUnauthorized, "Unauthenticated", "Sign in to continue."},
	CodeInvalidToken:          {http.StatusUnauthorized, "Invalid token", "The token is invalid or has been revoked."},
	CodeSessionExpired:        {http.StatusUnauthorized, "Session expired", "The session has expired. Sign in again."},
	CodeTwoFactorRequired:     {http.StatusUnauthorized, "Two-factor authentication required", "A second factor is required to finish signing in."},
	CodeInvalidTOTP:           {http.StatusUnauthorized, "Invalid authentication code", "The authentication code is incorrect."},
	CodePasskeyUnknown:        {http.StatusUnauthorized, "Unknown passkey", "This passkey is not registered."},
	CodePasskeyFailed:         {http.StatusUnauthorized, "Passkey verification failed", "The passkey could not be verified."},
	CodePasskeyExists:         {http.StatusConflict, "Passkey already registered", "This passkey is already registered."},
	CodeOAuthStateMismatch:    {http.StatusBadRequest, "Sign-in state mismatch", "The sign-in attempt could not be matched. Start again."},
	CodeOAuthEmailUnverified:  {http.StatusForbidden, "Email not verified", "The provider did not confirm a verified email address."},
	CodeInviteExpired:         {http.StatusGone, "Invitation expired", "The invitation has expired or was revoked."},
	CodeInviteEmailMismatch:   {http.StatusForbidden, "Invitation email mismatch", "The invitation was sent to a different email address."},
	CodeOwnerTransferRequired: {http.StatusConflict, "Ownership transfer required", "Transfer ownership of your organizations before deleting your account."},
	CodeAlreadyEnabled:        {http.StatusConflict, "Already enabled", "Two-factor authentication is already enabled."},
	CodeReauthRequired:        {http.StatusForbidden, "Recent sign-in required", "Sign in again to continue."},
	CodeEmailTaken:            {http.StatusConflict, "Email taken", "Another account already uses this email address."},
	CodeForbidden:             {http.StatusForbidden, "Forbidden", "You do not have permission to perform this action."},
	CodeInternal:              {http.StatusInternalServerError, "Internal error", "Something went wrong."},
}

// Status returns the HTTP status for code (500 for an unknown code).
func (c ErrCode) Status() int {
	if e, ok := catalogue[c]; ok {
		return e.status
	}
	return http.StatusInternalServerError
}

// Problem is the RFC 9457 problem body every identity endpoint returns on
// failure: Huma's ErrorModel plus the `code` and `retry_after` extension
// members. It is served as application/problem+json.
type Problem struct {
	huma.ErrorModel
	// Code is the stable machine-readable error code the UI maps to copy.
	Code ErrCode `json:"code" doc:"Stable machine-readable error code; see docs/architecture/identity.md."`
	// RetryAfter is the number of seconds to wait before retrying (rate
	// limits and lockouts). It mirrors the Retry-After header.
	RetryAfter int `json:"retry_after,omitempty" minimum:"1" doc:"Seconds to wait before retrying."`
}

// GetHeaders sets Retry-After when the problem carries a retry delay.
func (p *Problem) GetHeaders() http.Header {
	if p.RetryAfter <= 0 {
		return nil
	}
	return http.Header{"Retry-After": []string{strconv.Itoa(p.RetryAfter)}}
}

// Err builds the problem for code. Unknown codes collapse to internal_error
// so a typo can never leak an unvetted status or message.
func Err(code ErrCode) *Problem {
	e, ok := catalogue[code]
	if !ok {
		code, e = CodeInternal, catalogue[CodeInternal]
	}
	return &Problem{
		ErrorModel: huma.ErrorModel{Status: e.status, Title: e.title, Detail: e.detail},
		Code:       code,
	}
}

// ErrRetryAfter builds the problem for code with a retry delay, rounded up to
// whole seconds (at least one), set as both `retry_after` and Retry-After.
func ErrRetryAfter(code ErrCode, wait time.Duration) *Problem {
	p := Err(code)
	p.RetryAfter = max(1, int(math.Ceil(wait.Seconds())))
	return p
}
