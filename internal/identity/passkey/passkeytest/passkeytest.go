// Package passkeytest is a virtual WebAuthn authenticator for tests: it
// answers registration and sign-in options the way a browser and a platform
// authenticator would, with an ES256 key and "none" attestation, so the
// ceremonies run end to end without a browser.
package passkeytest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/google/uuid"
)

// Authenticator flag bits (WebAuthn §6.1).
const (
	flagUP = 0x01 // user present
	flagUV = 0x04 // user verified
	flagBE = 0x08 // backup eligible
	flagBS = 0x10 // backed up
	flagAT = 0x40 // attested credential data included
)

// Authenticator is one virtual authenticator holding one credential.
type Authenticator struct {
	// Origin is the web origin the virtual browser reports in clientDataJSON.
	Origin string
	// AAGUID names the authenticator model.
	AAGUID uuid.UUID
	// CredentialID is the credential's raw id; random by default.
	CredentialID []byte
	// BackupEligible and BackupState set the BE and BS flags (a synced
	// passkey has both).
	BackupEligible, BackupState bool
	// Transports are reported with the attestation response.
	Transports []string
	// UserHandle is returned with assertions; Register sets it from the
	// options' user.id, as a discoverable credential stores it.
	UserHandle []byte
	// SignCount is the signature counter reported by the next Register or
	// Login. Zero means the authenticator does not count (like most synced
	// passkeys).
	SignCount uint32

	key *ecdsa.PrivateKey
}

// New returns an authenticator for origin with a fresh P-256 key and a
// random 32-byte credential id.
func New(origin string, aaguid uuid.UUID) *Authenticator {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &Authenticator{Origin: origin, AAGUID: aaguid, CredentialID: id, Transports: []string{"internal", "hybrid"}, key: key}
}

// creationOptions is the part of a CredentialCreation the authenticator
// reads.
type creationOptions struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		RP        struct {
			ID string `json:"id"`
		} `json:"rp"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"publicKey"`
}

// Register answers the registration options (the CredentialCreation JSON,
// {"publicKey": {...}}) with a PublicKeyCredential JSON, as the browser
// would send it to the relying party.
func (a *Authenticator) Register(options []byte) (json.RawMessage, error) {
	var opts creationOptions
	if err := json.Unmarshal(options, &opts); err != nil {
		return nil, fmt.Errorf("passkeytest: decode options: %w", err)
	}
	handle, err := base64.RawURLEncoding.DecodeString(opts.PublicKey.User.ID)
	if err != nil {
		return nil, fmt.Errorf("passkeytest: decode user handle: %w", err)
	}
	a.UserHandle = handle
	clientData, err := json.Marshal(map[string]any{
		"type":        "webauthn.create",
		"challenge":   opts.PublicKey.Challenge,
		"origin":      a.Origin,
		"crossOrigin": false,
	})
	if err != nil {
		return nil, err
	}
	authData, err := a.authData(opts.PublicKey.RP.ID)
	if err != nil {
		return nil, err
	}
	attObj, err := webauthncbor.Marshal(map[string]any{
		"fmt":      "none",
		"attStmt":  map[string]any{},
		"authData": authData,
	})
	if err != nil {
		return nil, fmt.Errorf("passkeytest: encode attestation: %w", err)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	return json.Marshal(map[string]any{
		"id":    b64(a.CredentialID),
		"rawId": b64(a.CredentialID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"attestationObject": b64(attObj),
			"transports":        a.Transports,
		},
		"clientExtensionResults":  map[string]any{},
		"authenticatorAttachment": "platform",
	})
}

// authData builds the authenticator data with the attested credential.
func (a *Authenticator) authData(rpID string) ([]byte, error) {
	pub, err := a.key.PublicKey.ECDH()
	if err != nil {
		return nil, err
	}
	raw := pub.Bytes() // 0x04 || X || Y
	coseKey, err := webauthncbor.Marshal(map[int]any{
		1:  2,  // kty: EC2
		3:  -7, // alg: ES256
		-1: 1,  // crv: P-256
		-2: raw[1:33],
		-3: raw[33:65],
	})
	if err != nil {
		return nil, fmt.Errorf("passkeytest: encode key: %w", err)
	}
	rpHash := sha256.Sum256([]byte(rpID))
	flags := byte(flagUP | flagUV | flagAT)
	if a.BackupEligible {
		flags |= flagBE
	}
	if a.BackupState {
		flags |= flagBS
	}
	out := make([]byte, 0, 37+16+2+len(a.CredentialID)+len(coseKey))
	out = append(out, rpHash[:]...)
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, a.SignCount)
	out = append(out, a.AAGUID[:]...)
	out = binary.BigEndian.AppendUint16(out, uint16(len(a.CredentialID))) //nolint:gosec // ids are at most 1023 bytes
	out = append(out, a.CredentialID...)
	out = append(out, coseKey...)
	return out, nil
}

// requestOptions is the part of a CredentialAssertion the authenticator
// reads.
type requestOptions struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		RPID      string `json:"rpId"`
	} `json:"publicKey"`
}

// Login answers the sign-in options (the CredentialAssertion JSON,
// {"publicKey": {...}}) with a PublicKeyCredential JSON carrying an ES256
// assertion and UserHandle, as the browser would send it to the relying
// party. It does not check allowCredentials.
func (a *Authenticator) Login(options []byte) (json.RawMessage, error) {
	var opts requestOptions
	if err := json.Unmarshal(options, &opts); err != nil {
		return nil, fmt.Errorf("passkeytest: decode options: %w", err)
	}
	if opts.PublicKey.Challenge == "" || opts.PublicKey.RPID == "" {
		return nil, errors.New("passkeytest: options without challenge or rpId")
	}
	clientData, err := json.Marshal(map[string]any{
		"type":        "webauthn.get",
		"challenge":   opts.PublicKey.Challenge,
		"origin":      a.Origin,
		"crossOrigin": false,
	})
	if err != nil {
		return nil, err
	}
	rpHash := sha256.Sum256([]byte(opts.PublicKey.RPID))
	flags := byte(flagUP | flagUV)
	if a.BackupEligible {
		flags |= flagBE
	}
	if a.BackupState {
		flags |= flagBS
	}
	authData := make([]byte, 0, 37)
	authData = append(authData, rpHash[:]...)
	authData = append(authData, flags)
	authData = binary.BigEndian.AppendUint32(authData, a.SignCount)
	clientHash := sha256.Sum256(clientData)
	signed := make([]byte, 0, len(authData)+len(clientHash))
	signed = append(signed, authData...)
	signed = append(signed, clientHash[:]...)
	digest := sha256.Sum256(signed)
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		return nil, fmt.Errorf("passkeytest: sign: %w", err)
	}
	b64 := base64.RawURLEncoding.EncodeToString
	return json.Marshal(map[string]any{
		"id":    b64(a.CredentialID),
		"rawId": b64(a.CredentialID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64(clientData),
			"authenticatorData": b64(authData),
			"signature":         b64(sig),
			"userHandle":        b64(a.UserHandle),
		},
		"clientExtensionResults":  map[string]any{},
		"authenticatorAttachment": "platform",
	})
}
