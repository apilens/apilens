package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/valkey-io/valkey-go"
)

// OAuthStateTTL bounds how long a user may spend at the provider between
// /oauth/{provider}/start and the callback.
const OAuthStateTTL = 10 * time.Minute

// oauthStateKeyPrefix namespaces pending OAuth sign-ins in Valkey.
const oauthStateKeyPrefix = "apilens:oauth:state:"

// OAuth sign-in intents.
const (
	// OAuthIntentLogin signs in (or signs up) with the provider identity.
	OAuthIntentLogin = "login"
	// OAuthIntentLink attaches the provider identity to the signed-in user.
	OAuthIntentLink = "link"
)

// ErrOAuthStateNotFound means no pending sign-in matches the state: it never
// existed, expired, or was already used.
var ErrOAuthStateNotFound = errors.New("identity: oauth state not found")

// ErrOAuthStateUnavailable means the state store is not configured.
var ErrOAuthStateUnavailable = errors.New("identity: oauth state store unavailable (valkey not configured)")

// OAuthState is the server-side half of one authorization-code flow, keyed by
// the random `state` parameter. It never leaves the server: the browser only
// carries the state value.
type OAuthState struct {
	Provider string `json:"provider"`
	// Verifier is the PKCE code_verifier; the provider got its S256 challenge.
	Verifier string `json:"verifier"`
	// Nonce binds the OIDC id_token to this attempt (Google only).
	Nonce string `json:"nonce,omitempty"`
	// Next is the validated relative path to land on after sign-in.
	Next string `json:"next"`
	// Intent is OAuthIntentLogin or OAuthIntentLink.
	Intent string `json:"intent"`
	// LinkUserID is the signed-in user the identity is linked to (link only).
	LinkUserID string `json:"link_user_id,omitempty"`
	// Remember selects the long refresh-token lifetime.
	Remember bool `json:"remember"`
}

// OAuthStateStore keeps pending OAuth sign-ins for OAuthStateTTL.
type OAuthStateStore interface {
	// Put stores st under state. It fails if state is already taken.
	Put(ctx context.Context, state string, st OAuthState, ttl time.Duration) error
	// Take returns and deletes the entry for state, so a state is usable once.
	// It returns ErrOAuthStateNotFound when there is none.
	Take(ctx context.Context, state string) (OAuthState, error)
}

// ValkeyOAuthStateStore is the OAuthStateStore shared by every identity
// replica, so the callback may land on a different process than the start.
type ValkeyOAuthStateStore struct {
	client valkey.Client // nil: Valkey not configured
}

// NewValkeyOAuthStateStore returns a store on client. client may be nil when
// Valkey is not configured; every call then fails with
// ErrOAuthStateUnavailable.
func NewValkeyOAuthStateStore(client valkey.Client) *ValkeyOAuthStateStore {
	return &ValkeyOAuthStateStore{client: client}
}

// Put implements OAuthStateStore.
func (s *ValkeyOAuthStateStore) Put(ctx context.Context, state string, st OAuthState, ttl time.Duration) error {
	if s.client == nil {
		return ErrOAuthStateUnavailable
	}
	b, err := json.Marshal(st)
	if err != nil {
		return fmt.Errorf("identity: encode oauth state: %w", err)
	}
	cmd := s.client.B().Set().Key(oauthStateKeyPrefix + state).Value(string(b)).Nx().
		ExSeconds(max(1, int64(ttl/time.Second))).Build()
	if err := s.client.Do(ctx, cmd).Error(); err != nil {
		if valkey.IsValkeyNil(err) {
			return errors.New("identity: oauth state collision")
		}
		return fmt.Errorf("identity: store oauth state: %w", err)
	}
	return nil
}

// Take implements OAuthStateStore. GETDEL makes it atomic: two callbacks
// racing on one state cannot both succeed.
func (s *ValkeyOAuthStateStore) Take(ctx context.Context, state string) (OAuthState, error) {
	if s.client == nil {
		return OAuthState{}, ErrOAuthStateUnavailable
	}
	b, err := s.client.Do(ctx, s.client.B().Getdel().Key(oauthStateKeyPrefix+state).Build()).AsBytes()
	if err != nil {
		if valkey.IsValkeyNil(err) {
			return OAuthState{}, ErrOAuthStateNotFound
		}
		return OAuthState{}, fmt.Errorf("identity: load oauth state: %w", err)
	}
	var st OAuthState
	if err := json.Unmarshal(b, &st); err != nil {
		return OAuthState{}, fmt.Errorf("identity: decode oauth state: %w", err)
	}
	return st, nil
}
