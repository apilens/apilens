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

	"github.com/valkey-io/valkey-go"
)

// HandoffTTL bounds how long the UI has to redeem a handoff code after a
// browser sign-in (OAuth, SSO) redirected to it.
const HandoffTTL = 60 * time.Second

// handoffKeyPrefix namespaces pending handoff codes in Valkey.
const handoffKeyPrefix = "apilens:handoff:"

// handoffCodeBytes is the entropy of a handoff code (256 bits).
const handoffCodeBytes = 32

// ErrHandoffNotFound means no sign-in waits under the code: it never existed,
// expired, or was already redeemed.
var ErrHandoffNotFound = errors.New("identity: handoff code not found")

// ErrHandoffUnavailable means the handoff store is not configured.
var ErrHandoffUnavailable = errors.New("identity: handoff store unavailable (valkey not configured)")

// HandoffStore keeps the outcome of a browser sign-in (the session bundle or
// the 2fa_required answer) under a one-time code, so tokens never travel in a
// URL: the browser carries only the code to the UI, whose server side redeems
// it.
type HandoffStore interface {
	// Issue stores res under a new random code and returns the code.
	Issue(ctx context.Context, res SignInResponse, ttl time.Duration) (string, error)
	// Take returns and deletes the answer stored under code, so a code is
	// usable once. It returns ErrHandoffNotFound when there is none.
	Take(ctx context.Context, code string) (SignInResponse, error)
}

// ValkeyHandoffStore is the HandoffStore shared by every identity replica.
// Only the SHA-256 of a code is used as its key, so a Valkey dump does not
// hold usable codes.
type ValkeyHandoffStore struct {
	client valkey.Client // nil: Valkey not configured
}

// NewValkeyHandoffStore returns a store on client. client may be nil when
// Valkey is not configured; every call then fails with
// ErrHandoffUnavailable.
func NewValkeyHandoffStore(client valkey.Client) *ValkeyHandoffStore {
	return &ValkeyHandoffStore{client: client}
}

// Issue implements HandoffStore.
func (s *ValkeyHandoffStore) Issue(ctx context.Context, res SignInResponse, ttl time.Duration) (string, error) {
	if s.client == nil {
		return "", ErrHandoffUnavailable
	}
	buf := make([]byte, handoffCodeBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("identity: handoff code: %w", err)
	}
	code := base64.RawURLEncoding.EncodeToString(buf)
	b, err := json.Marshal(res) //nolint:gosec // G117: holding the session bundle for the UI to redeem is the point of a handoff
	if err != nil {
		return "", fmt.Errorf("identity: encode handoff: %w", err)
	}
	cmd := s.client.B().Set().Key(HandoffKey(code)).Value(string(b)).Nx().
		ExSeconds(max(1, int64(ttl/time.Second))).Build()
	if err := s.client.Do(ctx, cmd).Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return "", errors.New("identity: handoff code collision")
		}
		return "", fmt.Errorf("identity: store handoff: %w", err)
	}
	return code, nil
}

// Take implements HandoffStore. GETDEL makes it atomic: two redemptions
// racing on one code cannot both succeed.
func (s *ValkeyHandoffStore) Take(ctx context.Context, code string) (SignInResponse, error) {
	if s.client == nil {
		return SignInResponse{}, ErrHandoffUnavailable
	}
	b, err := s.client.Do(ctx, s.client.B().Getdel().Key(HandoffKey(code)).Build()).AsBytes()
	if err != nil {
		if valkey.IsValkeyNil(err) {
			return SignInResponse{}, ErrHandoffNotFound
		}
		return SignInResponse{}, fmt.Errorf("identity: load handoff: %w", err)
	}
	var res SignInResponse
	if err := json.Unmarshal(b, &res); err != nil {
		return SignInResponse{}, fmt.Errorf("identity: decode handoff: %w", err)
	}
	return res, nil
}

// HandoffKey is the Valkey key of a raw handoff code.
func HandoffKey(code string) string {
	sum := sha256.Sum256([]byte(code))
	return handoffKeyPrefix + hex.EncodeToString(sum[:])
}
