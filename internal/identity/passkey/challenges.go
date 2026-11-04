package passkey

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/valkey-io/valkey-go"
)

// ChallengeTTL bounds how long a ceremony may take between its options and
// verify requests.
const ChallengeTTL = 5 * time.Minute

// challengeKeyPrefix namespaces pending ceremonies in Valkey.
const challengeKeyPrefix = "apilens:webauthn:challenge:"

// Ceremony names the WebAuthn ceremony a challenge was issued for. A
// challenge is only accepted by the ceremony that issued it.
type Ceremony string

// Ceremonies.
const (
	CeremonyRegistration Ceremony = "registration"
	CeremonyLogin        Ceremony = "login"
)

// ErrChallengeNotFound means no pending ceremony matches the challenge id: it
// never existed, expired, was already used, or belongs to another ceremony.
var ErrChallengeNotFound = errors.New("passkey: challenge not found")

// ErrChallengeStoreUnavailable means the challenge store is not configured.
var ErrChallengeStoreUnavailable = errors.New("passkey: challenge store unavailable (valkey not configured)")

// ChallengeStore keeps webauthn.SessionData between a ceremony's options and
// verify requests.
type ChallengeStore interface {
	// Put stores sd for ChallengeTTL and returns the random challenge id to
	// hand to the client.
	Put(ctx context.Context, c Ceremony, sd webauthn.SessionData) (string, error)
	// Take returns and deletes the SessionData for id, so a challenge is
	// usable once. It returns ErrChallengeNotFound when there is none for c;
	// presenting an id to the wrong ceremony still deletes it.
	Take(ctx context.Context, c Ceremony, id string) (webauthn.SessionData, error)
}

// ValkeyChallengeStore is the ChallengeStore shared by every identity replica.
type ValkeyChallengeStore struct {
	client valkey.Client // nil: Valkey not configured
	ttl    time.Duration
}

// NewValkeyChallengeStore returns a store on client with ChallengeTTL. client
// may be nil when Valkey is not configured; every call then fails with
// ErrChallengeStoreUnavailable.
func NewValkeyChallengeStore(client valkey.Client) *ValkeyChallengeStore {
	return &ValkeyChallengeStore{client: client, ttl: ChallengeTTL}
}

// challengeEntry is the stored value: the session data tagged with its
// ceremony.
type challengeEntry struct {
	Ceremony Ceremony             `json:"ceremony"`
	Session  webauthn.SessionData `json:"session"`
}

// Put implements ChallengeStore.
func (s *ValkeyChallengeStore) Put(ctx context.Context, c Ceremony, sd webauthn.SessionData) (string, error) {
	if s.client == nil {
		return "", ErrChallengeStoreUnavailable
	}
	b, err := json.Marshal(challengeEntry{Ceremony: c, Session: sd})
	if err != nil {
		return "", fmt.Errorf("passkey: encode challenge: %w", err)
	}
	id := newChallengeID()
	cmd := s.client.B().Set().Key(challengeKeyPrefix + id).Value(string(b)).Nx().
		ExSeconds(max(1, int64(s.ttl/time.Second))).Build()
	if err := s.client.Do(ctx, cmd).Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return "", errors.New("passkey: challenge id collision")
		}
		return "", fmt.Errorf("passkey: store challenge: %w", err)
	}
	return id, nil
}

// Take implements ChallengeStore. GETDEL makes it atomic: two verify requests
// racing on one challenge cannot both succeed.
func (s *ValkeyChallengeStore) Take(ctx context.Context, c Ceremony, id string) (webauthn.SessionData, error) {
	if s.client == nil {
		return webauthn.SessionData{}, ErrChallengeStoreUnavailable
	}
	if id == "" {
		return webauthn.SessionData{}, ErrChallengeNotFound
	}
	b, err := s.client.Do(ctx, s.client.B().Getdel().Key(challengeKeyPrefix+id).Build()).AsBytes()
	if err != nil {
		if valkey.IsValkeyNil(err) {
			return webauthn.SessionData{}, ErrChallengeNotFound
		}
		return webauthn.SessionData{}, fmt.Errorf("passkey: load challenge: %w", err)
	}
	var e challengeEntry
	if err := json.Unmarshal(b, &e); err != nil {
		return webauthn.SessionData{}, fmt.Errorf("passkey: decode challenge: %w", err)
	}
	if e.Ceremony != c {
		return webauthn.SessionData{}, ErrChallengeNotFound
	}
	return e.Session, nil
}

// newChallengeID returns 32 random bytes, base64url-encoded.
func newChallengeID() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b) // crypto/rand.Read never fails (Go 1.24+)
	return base64.RawURLEncoding.EncodeToString(b)
}
