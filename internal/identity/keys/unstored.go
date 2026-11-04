package keys

import (
	"crypto"
	"fmt"
	"time"
)

// Unstored builds a Key for signer without storing it, with the kid and
// public JWK Store.Create would give it. It is for tests and tools that need
// a signing key outside the database; identity itself loads keys through
// Store or Manager.
func Unstored(signer crypto.Signer, activatedAt, retiredAt *time.Time) (Key, error) {
	priv, err := rsaKey(signer)
	if err != nil {
		return Key{}, err
	}
	kid := Thumbprint(&priv.PublicKey)
	jwk, err := publicJWK(kid, &priv.PublicKey)
	if err != nil {
		return Key{}, fmt.Errorf("keys: public JWK: %w", err)
	}
	return Key{
		KID: kid, Alg: AlgRS256, PublicJWK: jwk, CreatedAt: time.Now(),
		ActivatedAt: activatedAt, RetiredAt: retiredAt, private: priv,
	}, nil
}
