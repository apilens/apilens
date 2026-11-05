package email

import "fmt"

// Built-in templates (templates/*.tmpl) and the job data each one needs.
// Times are time.Time values (RFC 3339 strings once the job is stored);
// links are built from identity.public_ui_url by the template, so jobs carry
// tokens, never URLs.
const (
	// TemplateAuthCode: code (6 digits), token (magic link token) and email
	// (the address) for /verify?token=&email=, expires_in (for example
	// "15 minutes").
	TemplateAuthCode = "auth_code"
	// TemplateAuthNoAccount: email. Sent instead of auth_code when someone
	// asks to sign in with an address that has no account; links to
	// /sign-up?email=.
	TemplateAuthNoAccount = "auth_no_account"
	// TemplateEmailChange: code (6 digits), expires_in. Sent to the new
	// address of an email change.
	TemplateEmailChange = "email_change"
	// TemplateNewSignin: device, ip, time. Links to the Sessions page.
	TemplateNewSignin = "new_signin"
	// TemplateInvitation: org, inviter, role, token (for /invite/{token}),
	// expires_at.
	TemplateInvitation = "invitation"
	// TemplateSecurityChange: change (one of the SecurityChange values),
	// device, ip, time. Links to the Security page.
	TemplateSecurityChange = "security_change"
	// TemplateRecoveryRequested: token (for the cancel link), ip, time,
	// ready_at.
	TemplateRecoveryRequested = "recovery_requested"
	// TemplateRecoveryReady: token (for the status and cancel links).
	TemplateRecoveryReady = "recovery_ready"
	// TemplateAlertTriggered: rule, app, environment, metric (label),
	// value, threshold (for example "> 5%"), window (for example
	// "5 minutes"), started_at, project (slug) and event (id) for the
	// /<project>/incidents?event= link. Values come preformatted from
	// internal/alerts.
	TemplateAlertTriggered = "alert_triggered"
	// TemplateAlertResolved: the alert_triggered data with value the latest
	// evaluated value, plus ended_at.
	TemplateAlertResolved = "alert_resolved"
	// TemplateUptimeDown: app, environment, last_heartbeat, down_after
	// (for example "3 minutes"), project (slug) and event (id) for the
	// /<project>/incidents?event= link, from internal/alerts.
	TemplateUptimeDown = "uptime_down"
	// TemplateUptimeUp: app, environment, started_at (the last heartbeat
	// before the gap), ended_at, project and event.
	TemplateUptimeUp = "uptime_up"
	// TemplateHealthCheckFailing: app, environment, check (the checked URL
	// without its scheme, so the email links only to the UI),
	// expected_status, result ("HTTP 503 (expected 200)" or the failure
	// class), latency, attempts ("after 2 attempts"), body (the start of the
	// response body, masked; may be empty), body_truncated, started_at,
	// and project (slug, for the /<project>/settings/health-checks link),
	// from internal/alerts.
	TemplateHealthCheckFailing = "health_check_failing"
	// TemplateHealthCheckPassing: app, environment, check, expected_status,
	// started_at (when the check started failing), ended_at and project.
	TemplateHealthCheckPassing = "health_check_passing"
)

// Values of the security_change template's change field. An unknown value
// fails the render rather than sending a vague alert.
const (
	SecurityChangePasskeyAdded      = "passkey_added"
	SecurityChangePasskeyRemoved    = "passkey_removed"
	SecurityChangeTOTPEnabled       = "totp_enabled"
	SecurityChangeTOTPDisabled      = "totp_disabled"
	SecurityChangeBackupCodesReset  = "backup_codes_regenerated"
	SecurityChangeEmailChanged      = "email_changed"
	SecurityChangeRecoveryCompleted = "recovery_completed"
	SecurityChangeOAuthLinked       = "oauth_linked"
	SecurityChangeOAuthUnlinked     = "oauth_unlinked"
)

// securityChanges lists every SecurityChange value in display order.
var securityChanges = []string{
	SecurityChangePasskeyAdded, SecurityChangePasskeyRemoved,
	SecurityChangeTOTPEnabled, SecurityChangeTOTPDisabled, SecurityChangeBackupCodesReset,
	SecurityChangeEmailChanged, SecurityChangeRecoveryCompleted,
	SecurityChangeOAuthLinked, SecurityChangeOAuthUnlinked,
}

// SecurityCopy is the wording of one security_change email.
type SecurityCopy struct {
	Subject string // sentence case, no trailing full stop
	Summary string // one sentence for the body
}

var securityCopy = map[string]SecurityCopy{
	SecurityChangePasskeyAdded: {
		"A passkey was added to your APILens account",
		"A new passkey was added to your APILens account. It can now be used to sign in.",
	},
	SecurityChangePasskeyRemoved: {
		"A passkey was removed from your APILens account",
		"A passkey was removed from your APILens account. It can no longer be used to sign in.",
	},
	SecurityChangeTOTPEnabled: {
		"Two-factor authentication is on for your APILens account",
		"Two-factor authentication was turned on for your APILens account. Signing in now needs a code from your authenticator app.",
	},
	SecurityChangeTOTPDisabled: {
		"Two-factor authentication is off for your APILens account",
		"Two-factor authentication was turned off for your APILens account. Signing in no longer needs a code from your authenticator app.",
	},
	SecurityChangeBackupCodesReset: {
		"New backup codes for your APILens account",
		"New two-factor backup codes were generated for your APILens account. Your previous backup codes no longer work.",
	},
	SecurityChangeEmailChanged: {
		"The email address on your APILens account changed",
		"The email address on your APILens account was changed. Sign-in codes and alerts now go to the new address.",
	},
	SecurityChangeRecoveryCompleted: {
		"Your APILens account was recovered",
		"Your APILens account was recovered: two-factor authentication was turned off and every other session was signed out.",
	},
	SecurityChangeOAuthLinked: {
		"A sign-in provider was connected to your APILens account",
		"A Google or GitHub account was connected to your APILens account. It can now be used to sign in.",
	},
	SecurityChangeOAuthUnlinked: {
		"A sign-in provider was disconnected from your APILens account",
		"A Google or GitHub account was disconnected from your APILens account. It can no longer be used to sign in.",
	},
}

// securityChangeCopy returns the copy for change, or an error for an unknown
// value.
func securityChangeCopy(change string) (SecurityCopy, error) {
	c, ok := securityCopy[change]
	if !ok {
		return SecurityCopy{}, fmt.Errorf("security_change: unknown change %q", change)
	}
	return c, nil
}
