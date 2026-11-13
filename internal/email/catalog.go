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
	// TemplateReauthCode: code (6 digits), expires_in. Sent to the signed-in
	// user's address when they confirm who they are again before a
	// sensitive action (re-authentication); no sign-in link.
	TemplateReauthCode = "reauth_code"
	// TemplateProjectChange: change (one of the ProjectChange values),
	// project (name), slug (for the /<slug>/... link), actor (name or email
	// of who made the change), detail (the key name for key changes, the
	// new default access for default_access_changed, else empty) and time.
	// Sent to project admins by internal/controlplane/notify unless they
	// turned off the security_emails preference.
	TemplateProjectChange = "project_change"
	// TemplateProjectDeletionScheduled: project (name), slug, actor, time
	// and purge_at (when the project is removed for good). Sent to every
	// project admin, whatever their security_emails preference.
	TemplateProjectDeletionScheduled = "project_deletion_scheduled"
)

// Values of the project_change template's change field. An unknown value
// fails the render.
const (
	ProjectChangeKeyCreated           = "api_key_created"
	ProjectChangeKeyRotated           = "api_key_rotated"
	ProjectChangeKeyRevoked           = "api_key_revoked"
	ProjectChangeDefaultAccessChanged = "default_access_changed"
	ProjectChangeRestored             = "project_restored"
	ProjectChangePaused               = "project_paused"
	ProjectChangeResumed              = "project_resumed"
)

// ProjectChanges lists every ProjectChange value in display order.
var ProjectChanges = []string{
	ProjectChangeKeyCreated, ProjectChangeKeyRotated, ProjectChangeKeyRevoked,
	ProjectChangeDefaultAccessChanged,
	ProjectChangeRestored, ProjectChangePaused, ProjectChangeResumed,
}

// ProjectCopy is the wording of one project_change email.
type ProjectCopy struct {
	Subject string // sentence case, no trailing full stop
	Summary string // one sentence for the body
	Path    string // UI page the button opens, under /<slug>
	Button  string // button label
}

// projectChangeCopy returns the copy for change in project, made by actor;
// detail is the key name or the new default access. It is a template
// function: the template that prints the copy escapes it.
func projectChangeCopy(change, project, actor, detail string) (ProjectCopy, error) {
	keys := ProjectCopy{Path: "/access", Button: "Review API keys"}
	danger := ProjectCopy{Path: "/settings/danger", Button: "Open project settings"}
	var c ProjectCopy
	switch change {
	case ProjectChangeKeyCreated:
		c = keys
		c.Subject = fmt.Sprintf("An API key was created in %s", project)
		c.Summary = fmt.Sprintf("%s created the API key \"%s\" in the project %s.", actor, detail, project)
	case ProjectChangeKeyRotated:
		c = keys
		c.Subject = fmt.Sprintf("An API key was rotated in %s", project)
		c.Summary = fmt.Sprintf("%s rotated the API key \"%s\" in the project %s. The old secret stops working when the overlap window ends.", actor, detail, project)
	case ProjectChangeKeyRevoked:
		c = keys
		c.Subject = fmt.Sprintf("An API key was revoked in %s", project)
		c.Summary = fmt.Sprintf("%s revoked the API key \"%s\" in the project %s. SDKs that use it can no longer send data.", actor, detail, project)
	case ProjectChangeDefaultAccessChanged:
		c = ProjectCopy{Path: "/access", Button: "Review access"}
		c.Subject = fmt.Sprintf("Default access to %s changed", project)
		c.Summary = fmt.Sprintf("%s changed what organization members get on the project %s to: %s.", actor, project, detail)
	case ProjectChangeRestored:
		c = danger
		c.Subject = fmt.Sprintf("The project %s was restored", project)
		c.Summary = fmt.Sprintf("%s restored the project %s. Its deletion is cancelled and ingest is accepted again.", actor, project)
	case ProjectChangePaused:
		c = danger
		c.Subject = fmt.Sprintf("The project %s was paused", project)
		c.Summary = fmt.Sprintf("%s paused the project %s. Ingest is rejected until it is resumed.", actor, project)
	case ProjectChangeResumed:
		c = danger
		c.Subject = fmt.Sprintf("The project %s was resumed", project)
		c.Summary = fmt.Sprintf("%s resumed the project %s. Ingest is accepted again.", actor, project)
	default:
		return ProjectCopy{}, fmt.Errorf("project_change: unknown change %q", change)
	}
	return c, nil
}

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
