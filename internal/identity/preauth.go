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
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"
)

// preAuthKeyPrefix namespaces pending second-factor challenges in Valkey.
const preAuthKeyPrefix = "apilens:preauth:"

// preAuthTokenBytes is the entropy of a pre-auth token (256 bits).
const preAuthTokenBytes = 32

// PreAuthMaxAttempts is how many second-factor attempts one pre-auth token
// allows; the last wrong one deletes it.
const PreAuthMaxAttempts = 5

var (
	// ErrPreAuthUnavailable means the pre-auth store is not configured.
	ErrPreAuthUnavailable = errors.New("identity: pre-auth store unavailable (valkey not configured)")
	// ErrPreAuthNotFound means the pre-auth token is unknown, expired, used
	// or out of attempts.
	ErrPreAuthNotFound = errors.New("identity: pre-auth token not found")
)

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
	// OrgID is the organization of an SSO first factor, recorded on the
	// login.succeeded audit event once the second factor passes.
	OrgID string `json:"org_id,omitempty"`
	// Attempts counts second-factor attempts made with the token, the
	// current one included.
	Attempts int `json:"attempts"`
}

// PreAuthStore keeps pending second-factor challenges for
// identity.pre_auth_ttl.
type PreAuthStore interface {
	// Issue stores p under a new random token and returns the token.
	Issue(ctx context.Context, p PreAuth, ttl time.Duration) (string, error)
}

// PreAuthRedeemer spends pre-auth tokens at POST /api/v1/auth/2fa/exchange;
// *ValkeyPreAuthStore satisfies it.
type PreAuthRedeemer interface {
	// Attempt counts one second-factor attempt against raw and returns its
	// challenge, Attempts included. It answers ErrPreAuthNotFound for an
	// unknown, expired or used token and for one that already had
	// maxAttempts attempts (deleting it). Counting before the factor is
	// checked caps concurrent guesses too.
	Attempt(ctx context.Context, raw string, maxAttempts int) (PreAuth, error)
	// Delete removes raw, reporting whether it still existed: of two
	// concurrent successful exchanges only one gets true.
	Delete(ctx context.Context, raw string) (bool, error)
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

// preAuthAttempt counts one attempt against KEYS[1] (ARGV[1] the maximum):
// it returns the updated JSON challenge, or nil when the key is gone or out
// of attempts (then deleted). The value keeps its TTL. The read, check and
// write are one atomic step, so concurrent guesses cannot exceed the cap.
var preAuthAttempt = valkey.NewLuaScript(`
local v = redis.call('GET', KEYS[1])
if not v then return false end
local p = cjson.decode(v)
local n = (tonumber(p['attempts']) or 0) + 1
if n > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return false
end
p['attempts'] = n
local out = cjson.encode(p)
redis.call('SET', KEYS[1], out, 'KEEPTTL')
return out
`)

// Attempt implements PreAuthStore.
func (s *ValkeyPreAuthStore) Attempt(ctx context.Context, raw string, maxAttempts int) (PreAuth, error) {
	if s.client == nil {
		return PreAuth{}, ErrPreAuthUnavailable
	}
	if raw == "" {
		return PreAuth{}, ErrPreAuthNotFound
	}
	b, err := preAuthAttempt.Exec(ctx, s.client, []string{PreAuthKey(raw)}, []string{strconv.Itoa(maxAttempts)}).AsBytes()
	if valkey.IsValkeyNil(err) {
		return PreAuth{}, ErrPreAuthNotFound
	}
	if err != nil {
		return PreAuth{}, fmt.Errorf("identity: pre-auth attempt: %w", err)
	}
	var p PreAuth
	if err := json.Unmarshal(b, &p); err != nil {
		return PreAuth{}, fmt.Errorf("identity: decode pre-auth: %w", err)
	}
	return p, nil
}

// Delete implements PreAuthStore.
func (s *ValkeyPreAuthStore) Delete(ctx context.Context, raw string) (bool, error) {
	if s.client == nil {
		return false, ErrPreAuthUnavailable
	}
	n, err := s.client.Do(ctx, s.client.B().Del().Key(PreAuthKey(raw)).Build()).AsInt64()
	if err != nil {
		return false, fmt.Errorf("identity: delete pre-auth: %w", err)
	}
	return n > 0, nil
}

// PreAuthKey is the Valkey key of a raw pre-auth token.
func PreAuthKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return preAuthKeyPrefix + hex.EncodeToString(sum[:])
}
