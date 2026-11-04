// Package keys stores the identity role's JWT signing keys (ADR 0005).
//
// Keys live in the signing_keys table. The private half is PKCS#8 DER sealed
// with AES-256-GCM under identity.key_encryption_key (see Sealer); it is
// decrypted only inside identity processes and never logged: Key formats
// itself for fmt and slog without its private key.
//
// # Retirement window
//
// Exactly one key is active (signs new tokens). Rotating retires it and
// activates a new one, but a retired key stays in the published set returned
// by Store.Load for identity.refresh_token_ttl after retirement. JWKS
// verifiers (api, query, mcp) only accept tokens whose kid they can find, so
// dropping a key at rotation would instantly invalidate every token it signed
// and force every user to sign in again. The window must cover the longest
// lifetime of anything identity signs plus verifier JWKS caching and clock
// skew. refresh_token_ttl is the longest lifetime identity hands out, so it
// bounds every signed token (access tokens, and later OIDC ID and client
// tokens) with a wide margin and needs no retuning when a new signed token
// type appears. Public keys are not secret, so over-publishing costs nothing.
// On suspected compromise the key is removed outright instead (security
// runbook, §9).
package keys

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"time"
)

// AlgRS256 is the only signing algorithm identity issues (threat model: the
// verifier accepts only RS256).
const AlgRS256 = "RS256"

// MinRSABits is the smallest RSA modulus accepted for a signing key.
const MinRSABits = 2048

// Key is one signing key with its private half decrypted.
//
// Its String, GoString and LogValue methods omit the private key, so a Key
// can be passed to fmt or slog without leaking it.
type Key struct {
	KID         string
	Alg         string
	PublicJWK   json.RawMessage // the public JWK exactly as served in JWKS
	CreatedAt   time.Time
	ActivatedAt *time.Time // nil: published but not yet signing
	RetiredAt   *time.Time // non-nil: published only, never signs again

	private crypto.Signer
}

// Signer returns the private key for signing tokens.
func (k Key) Signer() crypto.Signer { return k.private }

// Active reports whether the key signs new tokens.
func (k Key) Active() bool { return k.ActivatedAt != nil && k.RetiredAt == nil }

// String describes the key without its private half.
func (k Key) String() string {
	return fmt.Sprintf("keys.Key{kid=%s alg=%s active=%t}", k.KID, k.Alg, k.Active())
}

// GoString keeps %#v from dumping the private key.
func (k Key) GoString() string { return k.String() }

// LogValue keeps slog from dumping the private key.
func (k Key) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("kid", k.KID),
		slog.String("alg", k.Alg),
		slog.Bool("active", k.Active()),
	)
}

// Active returns the key that signs new tokens, if any.
func Active(keys []Key) (Key, bool) {
	for _, k := range keys {
		if k.Active() {
			return k, true
		}
	}
	return Key{}, false
}

// rsaJWK is an RSA public key as a JWK (RFC 7517, RFC 7518 §6.3).
type rsaJWK struct {
	Kty string `json:"kty"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func rsaParams(pub *rsa.PublicKey) (n, e string) {
	return b64(pub.N.Bytes()), b64(big.NewInt(int64(pub.E)).Bytes())
}

// Thumbprint is the RFC 7638 JWK SHA-256 thumbprint of an RSA public key,
// used as its kid: stable, derived from the key, and reveals nothing secret.
func Thumbprint(pub *rsa.PublicKey) string {
	n, e := rsaParams(pub)
	// Required members only, in lexicographic order, no whitespace.
	sum := sha256.Sum256([]byte(`{"e":"` + e + `","kty":"RSA","n":"` + n + `"}`))
	return b64(sum[:])
}

// publicJWK renders the public half of an RS256 key for JWKS.
func publicJWK(kid string, pub *rsa.PublicKey) (json.RawMessage, error) {
	n, e := rsaParams(pub)
	return json.Marshal(rsaJWK{Kty: "RSA", Use: "sig", Alg: AlgRS256, Kid: kid, N: n, E: e})
}

// rsaKey checks that signer is an RSA key strong enough for RS256.
func rsaKey(signer crypto.Signer) (*rsa.PrivateKey, error) {
	priv, ok := signer.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("keys: %s needs an RSA private key, got %T", AlgRS256, signer)
	}
	if bits := priv.N.BitLen(); bits < MinRSABits {
		return nil, fmt.Errorf("keys: RSA key is %d bits, want at least %d", bits, MinRSABits)
	}
	return priv, nil
}

// JWKSet is a JSON Web Key Set (RFC 7517 §5) of public signing keys.
type JWKSet struct {
	Keys []json.RawMessage `json:"keys"`
}

// PublicSet renders ks as a JWK Set for GET /.well-known/jwks.json. Each
// key's stored JWK is decoded into the RSA public members only (kty, use,
// alg, kid, n, e) and re-encoded, so private members can never be served
// even if a stored JWK carried them.
func PublicSet(ks []Key) (JWKSet, error) {
	set := JWKSet{Keys: make([]json.RawMessage, 0, len(ks))}
	for _, k := range ks {
		var jwk rsaJWK
		if err := json.Unmarshal(k.PublicJWK, &jwk); err != nil {
			return JWKSet{}, fmt.Errorf("keys: key %s: public JWK: %w", k.KID, err)
		}
		if jwk.Kty != "RSA" || jwk.Kid != k.KID || jwk.N == "" || jwk.E == "" {
			return JWKSet{}, fmt.Errorf("keys: key %s: public JWK is not an RSA key with its kid", k.KID)
		}
		b, err := json.Marshal(jwk)
		if err != nil {
			return JWKSet{}, fmt.Errorf("keys: key %s: public JWK: %w", k.KID, err)
		}
		set.Keys = append(set.Keys, b)
	}
	return set, nil
}
