// Package passkey holds identity's WebAuthn relying party and the store for
// in-flight ceremonies.
//
// A ceremony spans two requests (options, then verify) that may land on
// different identity replicas, so the webauthn.SessionData between them lives
// in Valkey under a random challenge id. The id is returned to the client
// with the options and sent back with the verify request; the SessionData
// itself never leaves the server.
package passkey

import (
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/apilens/apilens/internal/platform/config"
)

// NewRelyingParty returns the WebAuthn relying party for cfg. It prefers, but
// does not require, discoverable credentials and user verification, so
// passkeys work for username-less sign-in while security keys without a PIN
// can still register.
func NewRelyingParty(cfg config.WebAuthnConfig) (*webauthn.WebAuthn, error) {
	if cfg.RPName == "" || len(cfg.Origins) == 0 {
		return nil, errors.New("passkey: rp_name and origins must be set")
	}
	if err := errors.Join(cfg.Validate()...); err != nil {
		return nil, fmt.Errorf("passkey: %w", err)
	}
	rp, err := webauthn.New(&webauthn.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPName,
		RPOrigins:     cfg.Origins,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementPreferred,
			UserVerification: protocol.VerificationPreferred,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("passkey: relying party: %w", err)
	}
	return rp, nil
}
