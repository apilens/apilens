// Package apikeys issues and verifies project-scoped ingest keys.
//
// Keys look like "apl_live_<43 base64url chars>" so secret scanners can spot
// leaks; legacy "apilens_..." keys from v1 are still accepted. Only the
// SHA-256 hex of the full key is stored. Verification is on the ingest hot
// path, so results are cached in-process (positive and negative) and
// invalidated across processes through Valkey pub/sub.
package apikeys

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"golang.org/x/sync/singleflight"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

const (
	// Prefix marks keys issued by v2.
	Prefix = "apl_live_"
	// LegacyPrefix marks keys issued by v1 (Django).
	LegacyPrefix = "apilens_"
	// DisplayPrefixLen is how much of a key is kept in clear for display.
	DisplayPrefixLen = 16
	// InvalidateChannel is the Valkey channel carrying revoked key hashes.
	InvalidateChannel = "apilens:apikeys:invalidate"

	maxKeyLen = 256
)

// ErrInvalidKey is returned for unknown, revoked, expired or malformed keys.
var ErrInvalidKey = errors.New("apikeys: invalid key")

// Principal is what a valid key authorises.
type Principal struct {
	KeyID       uuid.UUID
	ProjectID   uuid.UUID
	ProjectSlug string
	OrgID       uuid.UUID
	Scopes      []string
}

// HasScope reports whether the key carries scope.
func (p Principal) HasScope(scope string) bool {
	for _, s := range p.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// Generate returns a new raw key, its display prefix and its storage hash.
func Generate() (raw, prefix, hash string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", "", fmt.Errorf("apikeys: entropy: %w", err)
	}
	raw = Prefix + base64.RawURLEncoding.EncodeToString(buf)
	return raw, raw[:DisplayPrefixLen], Hash(raw), nil
}

// Hash returns the storage hash of a raw key.
func Hash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// WellFormed is a cheap pre-check that rejects obvious garbage before any
// hashing or lookup.
func WellFormed(raw string) bool {
	if len(raw) < 20 || len(raw) > maxKeyLen {
		return false
	}
	return strings.HasPrefix(raw, Prefix) || strings.HasPrefix(raw, LegacyPrefix)
}

// Lookup is the subset of the store the verifier needs.
type Lookup interface {
	GetActiveAPIKeyByHash(ctx context.Context, keyHash string) (db.GetActiveAPIKeyByHashRow, error)
	TouchAPIKey(ctx context.Context, id uuid.UUID) error
}

// Options configures the verifier cache.
type Options struct {
	Size        int
	TTL         time.Duration
	NegativeTTL time.Duration
	// TouchInterval bounds how often last_used_at is written per key.
	TouchInterval time.Duration
}

type entry struct {
	principal Principal
	valid     bool
}

// Verifier resolves raw keys to principals with caching.
type Verifier struct {
	lookup   Lookup
	logger   *slog.Logger
	positive *expirable.LRU[string, entry]
	negative *expirable.LRU[string, entry]
	group    singleflight.Group

	touchMu       sync.Mutex
	lastTouch     map[uuid.UUID]time.Time
	touchInterval time.Duration

	hits, misses prometheus.Counter
}

// NewVerifier builds a Verifier. reg may be nil.
func NewVerifier(lookup Lookup, opts Options, logger *slog.Logger, reg prometheus.Registerer) *Verifier {
	if opts.TouchInterval <= 0 {
		opts.TouchInterval = 5 * time.Minute
	}
	v := &Verifier{
		lookup:        lookup,
		logger:        logger,
		positive:      expirable.NewLRU[string, entry](opts.Size, nil, opts.TTL),
		negative:      expirable.NewLRU[string, entry](max(opts.Size/10, 1000), nil, opts.NegativeTTL),
		lastTouch:     map[uuid.UUID]time.Time{},
		touchInterval: opts.TouchInterval,
		hits:          prometheus.NewCounter(prometheus.CounterOpts{Name: "apilens_apikey_cache_hits_total", Help: "API key verifications served from cache."}),
		misses:        prometheus.NewCounter(prometheus.CounterOpts{Name: "apilens_apikey_cache_misses_total", Help: "API key verifications that hit the database."}),
	}
	if reg != nil {
		reg.MustRegister(v.hits, v.misses)
	}
	return v
}

// Verify resolves raw to a Principal or returns ErrInvalidKey.
func (v *Verifier) Verify(ctx context.Context, raw string) (Principal, error) {
	if !WellFormed(raw) {
		return Principal{}, ErrInvalidKey
	}
	hash := Hash(raw)
	if e, ok := v.positive.Get(hash); ok {
		v.hits.Inc()
		v.touch(e.principal.KeyID)
		return e.principal, nil
	}
	if _, ok := v.negative.Get(hash); ok {
		v.hits.Inc()
		return Principal{}, ErrInvalidKey
	}
	v.misses.Inc()

	res, err, _ := v.group.Do(hash, func() (any, error) {
		row, err := v.lookup.GetActiveAPIKeyByHash(ctx, hash)
		if errors.Is(err, pgx.ErrNoRows) {
			v.negative.Add(hash, entry{})
			return entry{}, nil
		}
		if err != nil {
			return entry{}, err
		}
		e := entry{valid: true, principal: Principal{
			KeyID: row.ID, ProjectID: row.ProjectID, ProjectSlug: row.ProjectSlug,
			OrgID: row.OrgID, Scopes: row.Scopes,
		}}
		v.positive.Add(hash, e)
		return e, nil
	})
	if err != nil {
		// Datastore trouble is not the caller's fault: surface it so the
		// edge answers 503 (retryable) rather than 401.
		return Principal{}, fmt.Errorf("apikeys: lookup: %w", err)
	}
	e := res.(entry)
	if !e.valid {
		return Principal{}, ErrInvalidKey
	}
	v.touch(e.principal.KeyID)
	return e.principal, nil
}

// Invalidate drops a key hash from both caches (called on revocation and
// when a Valkey invalidation message arrives).
func (v *Verifier) Invalidate(hash string) {
	v.positive.Remove(hash)
	v.negative.Remove(hash)
}

// touch records last use at most once per TouchInterval per key, off the
// request path.
func (v *Verifier) touch(id uuid.UUID) {
	now := time.Now()
	v.touchMu.Lock()
	last, seen := v.lastTouch[id]
	if seen && now.Sub(last) < v.touchInterval {
		v.touchMu.Unlock()
		return
	}
	v.lastTouch[id] = now
	v.touchMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := v.lookup.TouchAPIKey(ctx, id); err != nil {
			v.logger.Warn("failed to record api key use", "key_id", id, "error", err)
		}
	}()
}
