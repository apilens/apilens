package app

import (
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/platform/authn"
)

// TestLocalPublicKey covers the in-process key source used when identity
// runs in the same binary (target all).
func TestLocalPublicKey(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, keys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k, err := keys.Unstored(priv, &now, nil)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := localPublicKey([]keys.Key{k}, k.KID)
	if err != nil {
		t.Fatal(err)
	}
	if !priv.PublicKey.Equal(pub) {
		t.Error("returned key is not the signing key's public half")
	}
	if _, err := localPublicKey([]keys.Key{k}, "nope"); !errors.Is(err, authn.ErrUnknownKey) {
		t.Errorf("unknown kid: err = %v", err)
	}
}
