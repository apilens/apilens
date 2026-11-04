// Package identity is the built-in identity provider role: OIDC provider,
// passkeys, TOTP and sessions. It mounts its operations on the typed API.
package identity

import "github.com/danielgtaylor/huma/v2"

// Register mounts the identity operations on api. There are none yet; later
// M2 tasks add them.
func Register(api huma.API) {
	_ = api
}
