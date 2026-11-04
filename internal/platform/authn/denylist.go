package authn

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/valkey-io/valkey-go"
)

// DenylistCacheTTL is how long a verifier trusts its local answer for a
// `sid` before asking Valkey again: a session revoked by another process is
// refused within this long.
const DenylistCacheTTL = 5 * time.Second

// denylistPrefix namespaces denied session ids in Valkey.
const denylistPrefix = "authn:denied-sid:"

// denylistTimeout bounds one Valkey round trip on the request path.
const denylistTimeout = 500 * time.Millisecond

// denylistLogEvery rate-limits the "Valkey unavailable" log.
const denylistLogEvery = time.Minute

// denylistSize bounds each local cache.
const denylistSize = 100_000

// ErrRevoked means the token is well formed and signed but its session was
// revoked. It wraps ErrInvalidToken.
var ErrRevoked = fmt.Errorf("%w: session revoked", ErrInvalidToken)

// Denylist holds the session ids (`sid`) whose access tokens must be refused
// before they expire. Identity writes a sid when it revokes a session; every
// verifier reads it. Entries live in Valkey for one access-token TTL (plus
// Leeway), after which the token is refused for being expired anyway.
//
// Lookups are cached locally for DenylistCacheTTL. Sids denied by this
// process are refused for their whole TTL without asking Valkey. When Valkey
// is not configured or unreachable the denylist answers "not denied" and
// logs: access tokens then stay valid until they expire (TTL-only), as API
// key revocations propagate via the cache TTL only.
type Denylist struct {
	client valkey.Client // nil: Valkey not configured, TTL-only
	ttl    time.Duration
	logger *slog.Logger
	now    func() time.Time

	// own holds sids this process denied, for the full TTL.
	own *expirable.LRU[uuid.UUID, struct{}]
	// seen caches Valkey answers (and TTL-only fallbacks) briefly.
	seen *expirable.LRU[uuid.UUID, bool]

	lastLog atomic.Int64
}

// NewDenylist returns a denylist over client (nil: TTL-only) whose entries
// live accessTTL plus Leeway.
func NewDenylist(client valkey.Client, accessTTL time.Duration, logger *slog.Logger) *Denylist {
	ttl := accessTTL + Leeway
	return &Denylist{
		client: client,
		ttl:    ttl,
		logger: logger,
		now:    time.Now,
		own:    expirable.NewLRU[uuid.UUID, struct{}](denylistSize, nil, ttl),
		seen:   expirable.NewLRU[uuid.UUID, bool](denylistSize, nil, DenylistCacheTTL),
	}
}

// Deny refuses the access tokens of sids from now on. This process refuses
// them at once; others within DenylistCacheTTL, unless Valkey is unavailable,
// in which case Deny returns the error and the tokens stay valid elsewhere
// until they expire.
func (d *Denylist) Deny(ctx context.Context, sids ...uuid.UUID) error {
	if d == nil || len(sids) == 0 {
		return nil
	}
	for _, sid := range sids {
		d.own.Add(sid, struct{}{})
		d.seen.Add(sid, true)
	}
	if d.client == nil {
		return nil
	}
	cmds := make(valkey.Commands, 0, len(sids))
	for _, sid := range sids {
		cmds = append(cmds, d.client.B().Set().Key(denylistPrefix+sid.String()).Value("1").Px(d.ttl).Build())
	}
	for _, res := range d.client.DoMulti(ctx, cmds...) {
		if err := res.Error(); err != nil {
			return fmt.Errorf("authn: deny sessions: %w", err)
		}
	}
	return nil
}

// Denied reports whether sid was revoked. It never fails: when Valkey cannot
// answer, it logs (at most once a minute) and reports false.
func (d *Denylist) Denied(ctx context.Context, sid uuid.UUID) bool {
	if d == nil {
		return false
	}
	if _, ok := d.own.Get(sid); ok {
		return true
	}
	if denied, ok := d.seen.Get(sid); ok {
		return denied
	}
	if d.client == nil {
		return false
	}
	lctx, cancel := context.WithTimeout(ctx, denylistTimeout)
	defer cancel()
	n, err := d.client.Do(lctx, d.client.B().Exists().Key(denylistPrefix+sid.String()).Build()).AsInt64()
	if err != nil {
		if ctx.Err() != nil {
			// The caller went away; its request fails anyway.
			return false
		}
		d.logUnavailable(err)
		d.seen.Add(sid, false)
		return false
	}
	denied := n > 0
	d.seen.Add(sid, denied)
	return denied
}

// logUnavailable logs a Valkey failure at most once per denylistLogEvery.
func (d *Denylist) logUnavailable(err error) {
	now := d.now().UnixNano()
	last := d.lastLog.Load()
	if last != 0 && now-last < int64(denylistLogEvery) {
		return
	}
	if !d.lastLog.CompareAndSwap(last, now) {
		return
	}
	d.logger.Error("session denylist unavailable; revoked access tokens stay valid until they expire (TTL-only)", "error", err)
}
