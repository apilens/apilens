package keys

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
)

// sealVersion prefixes every sealed value so the format can change later
// (for example to support a second KEK during KEK rotation).
const sealVersion byte = 1

// KEKSize is the key encryption key length: AES-256.
const KEKSize = 32

// ErrDecrypt is returned when a sealed value cannot be opened: wrong KEK,
// tampered ciphertext, or ciphertext moved to another row (the additional
// data does not match). It never wraps the underlying cause, which could
// otherwise hint at key material.
var ErrDecrypt = errors.New("keys: cannot decrypt sealed value (wrong key encryption key or tampered data)")

// Sealer encrypts secrets at rest with AES-256-GCM under the identity key
// encryption key (identity.key_encryption_key).
//
// Sealed layout: version (1 byte) || nonce (12 bytes) || ciphertext+tag.
// The additional data binds a ciphertext to its owner (for signing keys,
// the kid), so a ciphertext copied onto another row fails to open.
type Sealer struct {
	aead cipher.AEAD
}

// NewSealer returns a Sealer for a 32-byte KEK.
func NewSealer(kek []byte) (*Sealer, error) {
	if len(kek) != KEKSize {
		return nil, fmt.Errorf("keys: key encryption key is %d bytes, want %d", len(kek), KEKSize)
	}
	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, fmt.Errorf("keys: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("keys: %w", err)
	}
	return &Sealer{aead: aead}, nil
}

// Seal encrypts plaintext with a fresh random nonce.
func (s *Sealer) Seal(plaintext, additionalData []byte) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("keys: nonce: %w", err)
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+s.aead.Overhead())
	out = append(append(out, sealVersion), nonce...)
	return s.aead.Seal(out, nonce, plaintext, additionalData), nil
}

// Open decrypts a value produced by Seal with the same additional data.
func (s *Sealer) Open(sealed, additionalData []byte) ([]byte, error) {
	ns := s.aead.NonceSize()
	if len(sealed) < 1+ns+s.aead.Overhead() || sealed[0] != sealVersion {
		return nil, ErrDecrypt
	}
	plaintext, err := s.aead.Open(nil, sealed[1:1+ns], sealed[1+ns:], additionalData)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}
