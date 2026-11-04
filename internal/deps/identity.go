// Package deps pins third-party modules that an ADR has chosen but that no
// production code imports yet. Importing them here keeps `go mod tidy` from
// dropping them and lets govulncheck scan them from day one.
//
// Nothing imports this package, so it is never linked into the apilens binary.
// Remove a blank import once real code imports that module.
package deps

import (
	// Identity (ADR 0005): OIDC/OAuth server, passkeys, TOTP, OIDC SSO client.
	_ "github.com/coreos/go-oidc/v3/oidc"
	_ "github.com/go-webauthn/webauthn/webauthn"
	_ "github.com/pquerna/otp/totp"
	_ "github.com/zitadel/oidc/v3/pkg/op"
	_ "golang.org/x/oauth2"

	// Transactional email (magic links, verification, invites).
	_ "github.com/wneessen/go-mail"

	// Background jobs (ADR 0008).
	_ "github.com/riverqueue/river"
	_ "github.com/riverqueue/river/riverdriver/riverpgxv5"
)
