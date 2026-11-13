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
	// CodePasskeyGone: the signed-in user has no passkey with that id (it
	// was removed, or never belonged to them).
	CodePasskeyGone ErrCode = "passkey_gone"
	// CodeOAuthStateMismatch: the OAuth/OIDC callback state or PKCE verifier
	// does not match the login attempt.
	CodeOAuthStateMismatch ErrCode = "oauth_state_mismatch"
	// CodeOAuthEmailUnverified: the external provider did not assert a
	// verified email, so it cannot be linked to an account.
	CodeOAuthEmailUnverified ErrCode = "oauth_email_unverified"
	// CodeOAuthIdentityGone: the signed-in user has no connected provider
	// account with that id (it was disconnected, or never belonged to them).
	CodeOAuthIdentityGone ErrCode = "oauth_identity_gone"
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
	// CodeNotEnabled: two-factor authentication is off, so there is nothing
	// to disable and no backup codes to regenerate.
	CodeNotEnabled ErrCode = "not_enabled"
	// CodeReauthRequired: the action needs a recent sign-in and the session
	// signed in too long ago; sign in again, then retry.
	CodeReauthRequired ErrCode = "reauth_required"
	// CodeEmailTaken: another account uses the address. Only answered to a
	// signed-in user changing their own email, never on sign-in or sign-up.
	CodeEmailTaken ErrCode = "email_taken"
	// CodeAccountDeleting: the sign-in matched an account that was deleted
	// and is waiting out its grace period. The problem carries
	// `delete_after`; POST /api/v1/users/me/restore with a fresh email code
	// restores it. Only sent after the caller proved control of the address,
	// so it reveals nothing to a stranger.
	CodeAccountDeleting ErrCode = "account_deleting"
	// CodeSlugTaken: the organization or project slug is reserved or used by
	// another active one. The problem carries up to three free
	// `suggestions`.
	CodeSlugTaken ErrCode = "slug_taken"
	// CodeRecoveryNotReady: the account recovery request is still in its
	// cooling-off period (identity.recovery_delay); retry_after says how long
	// is left. It can still be cancelled.
	CodeRecoveryNotReady ErrCode = "recovery_not_ready"
	// CodeSlugImmutable: the update asks for a different organization or
	// project slug; slugs cannot be changed yet.
	CodeSlugImmutable ErrCode = "slug_immutable"
	// CodeDomainNotAllowed: an allowed domain is a public email provider
	// (gmail.com, outlook.com, …) that anyone can hold an address at.
	CodeDomainNotAllowed ErrCode = "domain_not_allowed"
	// CodeLastOwner: the change would leave the organization without an
	// owner; make someone else an owner first.
	CodeLastOwner ErrCode = "last_owner"
	// CodeMemberGone: the user is not a member of the organization (they
	// left or were removed). Only answered to members of the organization.
	CodeMemberGone ErrCode = "member_gone"
	// CodeSSORequired: the email's domain belongs to an organization that
	// enforces single sign-on, so email and social sign-in are refused. The
	// problem carries `start_url`; a browser callback redirects with
	// ?error=sso_required instead.
	CodeSSORequired ErrCode = "sso_required"
	// CodeSSONotConfigured: the organization has no single sign-on
	// connection.
	CodeSSONotConfigured ErrCode = "sso_not_configured"
	// CodeSSOUntested: turning SSO enforcement on needs the caller to have
	// signed in through the organization's connection at least once.
	CodeSSOUntested ErrCode = "sso_untested"
	// CodeSSODomainTaken: another organization already enforces single
	// sign-on for one of the domains.
	CodeSSODomainTaken ErrCode = "sso_domain_taken"
	// CodeAPIKeyGone: the project has no API key with that id. Only
	// answered to members of the project's organization.
	CodeAPIKeyGone ErrCode = "api_key_gone"
	// CodeKeyLimitReached: the project already has as many active API keys
	// as it may (ingest.max_keys_per_project); revoke one first.
	CodeKeyLimitReached ErrCode = "key_limit_reached"
	// CodeKeyNotActive: the API key is revoked, expired or already rotated,
	// so it cannot be rotated.
	CodeKeyNotActive ErrCode = "key_not_active"
	// CodeNotOrgMember: a project role can only be granted to a member of
	// the project's organization; invite the person to the organization
	// first.
	CodeNotOrgMember ErrCode = "not_org_member"
	// CodeMemberLimitReached: the project already has as many people added
	// directly as it may (access.max_direct_members_per_project).
	CodeMemberLimitReached ErrCode = "member_limit_reached"
	// CodeForbidden: authenticated and able to see the resource, but not
	// allowed to perform the action.
	CodeForbidden ErrCode = "forbidden"
	// CodeNotFound: the organization or project does not exist, or the
	// caller cannot see it; the two cannot be told apart.
	CodeNotFound ErrCode = "not_found"
	// CodeAuthzUnavailable: permissions could not be checked (SpiceDB is
	// down or unreachable), so the request was refused (fail closed).
	// retry_after says when to try again.
	CodeAuthzUnavailable ErrCode = "authz_unavailable"
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
	CodePasskeyGone:           {http.StatusGone, "Passkey removed", "The passkey was removed or is not on this account."},
	CodeOAuthStateMismatch:    {http.StatusBadRequest, "Sign-in state mismatch", "The sign-in attempt could not be matched. Start again."},
	CodeOAuthEmailUnverified:  {http.StatusForbidden, "Email not verified", "The provider did not confirm a verified email address."},
	CodeOAuthIdentityGone:     {http.StatusGone, "Connected account removed", "The connected account was already removed or is not on this account."},
	CodeInviteExpired:         {http.StatusGone, "Invitation expired", "The invitation has expired or was revoked."},
	CodeInviteEmailMismatch:   {http.StatusForbidden, "Invitation email mismatch", "The invitation was sent to a different email address."},
	CodeOwnerTransferRequired: {http.StatusConflict, "Ownership transfer required", "Transfer ownership of your organizations before deleting your account."},
	CodeAlreadyEnabled:        {http.StatusConflict, "Already enabled", "Two-factor authentication is already enabled."},
	CodeNotEnabled:            {http.StatusConflict, "Not enabled", "Two-factor authentication is not enabled."},
	CodeReauthRequired:        {http.StatusForbidden, "Recent sign-in required", "Sign in again to continue."},
	CodeEmailTaken:            {http.StatusConflict, "Email taken", "Another account already uses this email address."},
	CodeAccountDeleting:       {http.StatusConflict, "Account scheduled for deletion", "This account was deleted and will be removed for good after delete_after. Restore it with a new email code."},
	CodeSlugTaken:             {http.StatusConflict, "Slug taken", "This slug is not available. Pick another one."},
	CodeRecoveryNotReady:      {http.StatusConflict, "Recovery not ready", "Account recovery is still in its waiting period. Try again after it ends."},
	CodeSlugImmutable:         {http.StatusConflict, "Slug cannot be changed", "This slug cannot be changed."},
	CodeDomainNotAllowed:      {http.StatusBadRequest, "Domain not allowed", "Public email domains cannot be claimed by an organization."},
	CodeLastOwner:             {http.StatusConflict, "Last owner", "An organization must keep at least one owner."},
	CodeMemberGone:            {http.StatusGone, "Member gone", "The user is not a member of this organization."},
	CodeAPIKeyGone:            {http.StatusGone, "API key gone", "The project has no such API key."},
	CodeKeyLimitReached:       {http.StatusConflict, "API key limit reached", "This project has as many active API keys as it may have. Revoke one first."},
	CodeKeyNotActive:          {http.StatusConflict, "API key not active", "The API key is revoked, expired or already rotated."},
	CodeNotOrgMember:          {http.StatusConflict, "Not an organization member", "Only members of the project's organization can be added to it."},
	CodeMemberLimitReached:    {http.StatusConflict, "Member limit reached", "This project has as many people added directly as it may have. Remove someone first."},
	CodeSSORequired:           {http.StatusForbidden, "Single sign-on required", "This organization requires single sign-on. Sign in through its identity provider."},
	CodeSSONotConfigured:      {http.StatusConflict, "Single sign-on not configured", "This organization has no single sign-on connection."},
	CodeSSOUntested:           {http.StatusConflict, "Single sign-on untested", "Sign in through single sign-on at least once before enforcing it."},
	CodeSSODomainTaken:        {http.StatusConflict, "Domain enforced elsewhere", "Another organization already enforces single sign-on for this domain."},
	CodeForbidden:             {http.StatusForbidden, "Forbidden", "You do not have permission to perform this action."},
	CodeNotFound:              {http.StatusNotFound, "Not found", "The resource does not exist or you do not have access to it."},
	CodeAuthzUnavailable:      {http.StatusServiceUnavailable, "Authorization unavailable", "Permissions could not be checked. Try again shortly."},
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
	// DeleteAfter is when a deleted account is removed for good
	// (account_deleting only).
	DeleteAfter *time.Time `json:"delete_after,omitempty" doc:"When the deleted account is removed for good (account_deleting only)."`
	// Suggestions are free alternative slugs (slug_taken only).
	Suggestions []string `json:"suggestions,omitempty" maxItems:"3" doc:"Free alternative slugs (slug_taken only)."`
	// StartURL is where to start the SSO sign-in of the organization that
	// enforces it (sso_required only).
	StartURL string `json:"start_url,omitempty" doc:"Where to send the browser to sign in through the organization's identity provider (sso_required only)."`
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

// ErrAccountDeleting builds the account_deleting problem for an account
// that is removed for good at deleteAfter.
func ErrAccountDeleting(deleteAfter time.Time) *Problem {
	p := Err(CodeAccountDeleting)
	t := deleteAfter.UTC()
	p.DeleteAfter = &t
	return p
}

// ErrSlugTaken builds the slug_taken problem offering suggestions.
func ErrSlugTaken(suggestions []string) *Problem {
	p := Err(CodeSlugTaken)
	p.Suggestions = suggestions
	return p
}

// ErrSSORequired builds the sso_required problem pointing at startURL, the
// SSO start of the organization that enforces it.
func ErrSSORequired(startURL string) *Problem {
	p := Err(CodeSSORequired)
	p.StartURL = startURL
	return p
}

// ErrRetryAfter builds the problem for code with a retry delay, rounded up to
// whole seconds (at least one), set as both `retry_after` and Retry-After.
func ErrRetryAfter(code ErrCode, wait time.Duration) *Problem {
	p := Err(code)
	p.RetryAfter = max(1, int(math.Ceil(wait.Seconds())))
	return p
}
