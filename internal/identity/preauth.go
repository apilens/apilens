package identity

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"
)

// preAuthKeyPrefix namespaces pending second-factor challenges in Valkey.
const preAuthKeyPrefix = "apilens:preauth:"

// preAuthTokenBytes is the entropy of a pre-auth token (256 bits).
const preAuthTokenBytes = 32

// ErrPreAuthUnavailable means the pre-auth store is not configured.
var ErrPreAuthUnavailable = errors.New("identity: pre-auth store unavailable (valkey not configured)")

// PreAuth is a first factor that succeeded for a user with TOTP confirmed:
// everything needed to finish the sign-in once the second factor checks out.
// It lives server-side only; the client holds the opaque pre-auth token.
type PreAuth struct {
	UserID uuid.UUID `json:"user_id"`
	// AMR is how the first factor authenticated (token.AMR* values).
	AMR []string `json:"amr"`
	// Remember selects the long refresh-token lifetime.
	Remember bool `json:"remember"`
	// Next is the validated relative path to land on after sign-in.
	Next string `json:"next,omitempty"`
	// Attempts counts wrong second-factor guesses.
	Attempts int `json:"attempts"`
}

// PreAuthStore keeps pending second-factor challenges for
// identity.pre_auth_ttl.
type PreAuthStore interface {
	// Issue stores p under a new random token and returns the token.
	Issue(ctx context.Context, p PreAuth, ttl time.Duration) (string, error)
}

// ValkeyPreAuthStore is the PreAuthStore shared by every identity replica.
// Only the SHA-256 of a token is used as its key, so a Valkey dump does not
// hold usable tokens.
type ValkeyPreAuthStore struct {
	client valkey.Client // nil: Valkey not configured
}

// NewValkeyPreAuthStore returns a store on client. client may be nil when
// Valkey is not configured; every call then fails with
// ErrPreAuthUnavailable.
func NewValkeyPreAuthStore(client valkey.Client) *ValkeyPreAuthStore {
	return &ValkeyPreAuthStore{client: client}
}

// Issue implements PreAuthStore.
func (s *ValkeyPreAuthStore) Issue(ctx context.Context, p PreAuth, ttl time.Duration) (string, error) {
	if s.client == nil {
		return "", ErrPreAuthUnavailable
	}
	buf := make([]byte, preAuthTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("identity: pre-auth token: %w", err)
	}
	raw := base64.RawURLEncoding.EncodeToString(buf)
	b, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("identity: encode pre-auth: %w", err)
	}
	cmd := s.client.B().Set().Key(PreAuthKey(raw)).Value(string(b)).Nx().
		ExSeconds(max(1, int64(ttl/time.Second))).Build()
	if err := s.client.Do(ctx, cmd).Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return "", errors.New("identity: pre-auth token collision")
		}
		return "", fmt.Errorf("identity: store pre-auth: %w", err)
	}
	return raw, nil
}

// PreAuthKey is the Valkey key of a raw pre-auth token.
func PreAuthKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return preAuthKeyPrefix + hex.EncodeToString(sum[:])
}
