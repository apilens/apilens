package authn

import (
	"context"
	"crypto"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
	"golang.org/x/sync/singleflight"
)

var (
	// ErrUnknownKey means no published key has the token's `kid`.
	ErrUnknownKey = errors.New("authn: unknown signing key")
	// ErrUnavailable means the keys could not be loaded at all, so no token
	// can be verified. Callers fail closed (503), never open.
	ErrUnavailable = errors.New("authn: signing keys unavailable")
)

// KeySource returns the public key identity published under kid. JWKS
// fetches it over HTTP; the composition root supplies an in-process source
// when identity runs in the same binary.
type KeySource interface {
	PublicKey(ctx context.Context, kid string) (crypto.PublicKey, error)
}

// KeySourceFunc adapts a function to KeySource.
type KeySourceFunc func(ctx context.Context, kid string) (crypto.PublicKey, error)

// PublicKey calls f.
func (f KeySourceFunc) PublicKey(ctx context.Context, kid string) (crypto.PublicKey, error) {
	return f(ctx, kid)
}

// JWKSOptions configures a JWKS cache.
type JWKSOptions struct {
	// Client fetches the key set. Nil means a client with a 5s timeout.
	Client *http.Client
	// MinRefresh is the minimum time between fetches (default 1 minute), so
	// tokens with made-up kids cannot hammer identity.
	MinRefresh time.Duration
	// MaxAge is how long a fetched set is used before it is refetched on the
	// next lookup (default 5 minutes, identity's Cache-Control max-age).
	MaxAge time.Duration
	// RetryAfterFailure is the minimum time between fetches after a failed
	// one (default 5 seconds), so a cold cache recovers quickly once
	// identity is reachable without retrying on every request.
	RetryAfterFailure time.Duration
	// Now returns the current time. Nil means time.Now.
	Now func() time.Time
}

// JWKS caches identity's published signing keys. A lookup for an unknown
// kid refetches the set (rate limited by MinRefresh), which picks up a
// rotated key without waiting for MaxAge. If the set cannot be fetched the
// cached keys keep working; with nothing cached, lookups fail with
// ErrUnavailable.
type JWKS struct {
	url  string
	opts JWKSOptions

	mu        sync.RWMutex
	keys      map[string]crypto.PublicKey
	fetchedAt time.Time // last successful fetch
	nextFetch time.Time // earliest time another fetch may start
	group     singleflight.Group
}

// maxJWKSBytes bounds the key set response.
const maxJWKSBytes = 1 << 20

// NewJWKS returns a cache over the JWK Set served at url. Nothing is fetched
// until the first lookup.
func NewJWKS(url string, opts JWKSOptions) *JWKS {
	if opts.Client == nil {
		opts.Client = &http.Client{Timeout: 5 * time.Second}
	}
	if opts.MinRefresh <= 0 {
		opts.MinRefresh = time.Minute
	}
	if opts.MaxAge <= 0 {
		opts.MaxAge = 5 * time.Minute
	}
	if opts.RetryAfterFailure <= 0 {
		opts.RetryAfterFailure = 5 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &JWKS{url: url, opts: opts}
}

// PublicKey returns the key published under kid.
func (j *JWKS) PublicKey(ctx context.Context, kid string) (crypto.PublicKey, error) {
	now := j.opts.Now()
	j.mu.RLock()
	key, found := j.keys[kid]
	fresh := !j.fetchedAt.IsZero() && now.Sub(j.fetchedAt) < j.opts.MaxAge
	mayFetch := !now.Before(j.nextFetch)
	j.mu.RUnlock()

	if (found && fresh) || !mayFetch {
		return j.result(key, found)
	}
	// Errors are already reflected in the cache state read by result.
	_, _, _ = j.group.Do("fetch", func() (any, error) { return nil, j.refresh(ctx) })

	j.mu.RLock()
	key, found = j.keys[kid]
	j.mu.RUnlock()
	return j.result(key, found)
}

func (j *JWKS) result(key crypto.PublicKey, found bool) (crypto.PublicKey, error) {
	if found {
		return key, nil
	}
	j.mu.RLock()
	empty := j.keys == nil
	j.mu.RUnlock()
	if empty {
		return nil, ErrUnavailable
	}
	return nil, ErrUnknownKey
}

// refresh fetches the key set and replaces the cache on success.
func (j *JWKS) refresh(ctx context.Context) error {
	j.mu.Lock()
	now := j.opts.Now()
	if now.Before(j.nextFetch) { // another caller just fetched
		j.mu.Unlock()
		return nil
	}
	j.nextFetch = now.Add(j.opts.RetryAfterFailure)
	j.mu.Unlock()

	keys, err := j.fetch(ctx)
	if err != nil {
		return err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.keys = keys
	j.fetchedAt = now
	j.nextFetch = now.Add(j.opts.MinRefresh)
	return nil
}

func (j *JWKS) fetch(ctx context.Context) (map[string]crypto.PublicKey, error) {
	// The fetch serves every waiting caller, so it outlives any one of them.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, j.url, nil)
	if err != nil {
		return nil, fmt.Errorf("authn: jwks request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := j.opts.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("authn: fetch jwks: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("authn: fetch jwks: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJWKSBytes))
	if err != nil {
		return nil, fmt.Errorf("authn: read jwks: %w", err)
	}
	var set jose.JSONWebKeySet
	if err := json.Unmarshal(body, &set); err != nil {
		return nil, fmt.Errorf("authn: parse jwks: %w", err)
	}
	keys := make(map[string]crypto.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		pub, ok := k.Key.(*rsa.PublicKey)
		if !ok || k.KeyID == "" || !k.IsPublic() {
			continue // only RSA public keys with a kid can verify our tokens
		}
		keys[k.KeyID] = pub
	}
	return keys, nil
}
