package authz

import (
	"context"
	"time"

	"github.com/valkey-io/valkey-go"
)

// TokenStore holds the latest ZedToken written for each organization, shared
// by every replica.
type TokenStore interface {
	// Get returns the latest token for org, or "" when none is stored.
	Get(ctx context.Context, org string) (string, error)
	// Set records token as the latest write for org.
	Set(ctx context.Context, org, token string) error
}

// tokenKeyPrefix namespaces ZedTokens in Valkey.
const tokenKeyPrefix = "apilens:authz:zedtoken:" //nolint:gosec // a key prefix, not a credential

// tokenTTL bounds how long a token is kept. Long after a write, SpiceDB's
// own quantized snapshot is newer than the token anyway, so dropping it only
// switches reads back to minimize_latency.
const tokenTTL = time.Hour

// ValkeyTokens stores ZedTokens in Valkey.
type ValkeyTokens struct {
	client valkey.Client
}

// NewValkeyTokens returns a TokenStore backed by client.
func NewValkeyTokens(client valkey.Client) *ValkeyTokens { return &ValkeyTokens{client: client} }

// Get implements TokenStore.
func (s *ValkeyTokens) Get(ctx context.Context, org string) (string, error) {
	token, err := s.client.Do(ctx, s.client.B().Get().Key(tokenKeyPrefix+org).Build()).ToString()
	if valkey.IsValkeyNil(err) {
		return "", nil
	}
	return token, err
}

// Set implements TokenStore.
func (s *ValkeyTokens) Set(ctx context.Context, org, token string) error {
	return s.client.Do(ctx, s.client.B().Set().Key(tokenKeyPrefix+org).Value(token).Ex(tokenTTL).Build()).Error()
}

// noTokens is the TokenStore used when none is configured.
type noTokens struct{}

func (noTokens) Get(context.Context, string) (string, error) { return "", nil }
func (noTokens) Set(context.Context, string, string) error   { return nil }
