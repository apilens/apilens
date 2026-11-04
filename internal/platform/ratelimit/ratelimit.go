// Package ratelimit enforces rate limits shared across replicas. Each limit
// is a sliding window (a sorted-set log, updated atomically by a Lua script)
// keyed in Valkey, so every process sees the same counts.
//
// Limits fail closed: when Valkey is not configured or unreachable the
// request is refused with 503 instead of being let through, and the outage is
// logged at most once a minute.
package ratelimit

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/valkey-io/valkey-go"
)

// keyPrefix namespaces every rate-limit key in Valkey.
const keyPrefix = "apilens:ratelimit:"

// logEvery bounds how often an unavailable backend is logged.
const logEvery = time.Minute

// ErrUnavailable means the limit could not be checked because Valkey is not
// configured or did not answer. Callers must refuse the request.
var ErrUnavailable = errors.New("ratelimit: valkey unavailable")

// Rate allows Limit requests per sliding Window. The zero Rate disables the
// limit. It converts directly from config.RateLimit.
type Rate struct {
	Limit  int
	Window time.Duration
}

// Enabled reports whether r limits anything.
func (r Rate) Enabled() bool { return r.Limit > 0 && r.Window > 0 }

// Result is the outcome of one Allow call.
type Result struct {
	Allowed bool
	// Remaining is how many more requests the window admits.
	Remaining int
	// RetryAfter is how long until the next request would be admitted; zero
	// when Allowed.
	RetryAfter time.Duration
}

// slidingWindow records one hit in KEYS[1] unless the window is full.
// ARGV: window (µs), limit, random member suffix. Returns
// {allowed (0|1), remaining, retry_after (µs)}. Valkey's clock is used so
// replicas with skewed clocks share one timeline. Numbers are formatted with
// %d: Lua would otherwise stringify large values in exponent notation.
var slidingWindow = valkey.NewLuaScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000000 + tonumber(t[2])
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%d', now - window))
local n = redis.call('ZCARD', KEYS[1])
if n < limit then
  local score = string.format('%d', now)
  redis.call('ZADD', KEYS[1], score, score .. '-' .. ARGV[3])
  redis.call('PEXPIRE', KEYS[1], string.format('%d', math.ceil(window / 1000)))
  return {1, limit - n - 1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = tonumber(oldest[2]) + window - now
if retry < 1 then retry = 1 end
return {0, 0, retry}
`)

// Limiter checks rate limits against Valkey.
type Limiter struct {
	client  valkey.Client // nil: Valkey not configured, every check fails closed
	logger  *slog.Logger
	proxies []netip.Prefix
	lastLog atomic.Int64 // unix nanos of the last "unavailable" log line
	now     func() time.Time
}

// New returns a Limiter. client may be nil when Valkey is not configured; the
// limiter then refuses every limited request. trustedProxies are IPs or CIDRs
// whose X-Forwarded-For entries are believed when resolving the client IP.
func New(client valkey.Client, logger *slog.Logger, trustedProxies []string) (*Limiter, error) {
	proxies := make([]netip.Prefix, 0, len(trustedProxies))
	for _, p := range trustedProxies {
		prefix, err := parsePrefix(p)
		if err != nil {
			return nil, err
		}
		proxies = append(proxies, prefix)
	}
	return &Limiter{client: client, logger: logger, proxies: proxies, now: time.Now}, nil
}

func parsePrefix(s string) (netip.Prefix, error) {
	if p, err := netip.ParsePrefix(s); err == nil {
		return p.Masked(), nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("ratelimit: trusted proxy %q: want an IP or CIDR", s)
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// Allow records one request against limit name for key and reports whether
// it is admitted. Rejected requests are not recorded. A disabled rate or an
// empty key always admits. The error is ErrUnavailable (wrapped) when Valkey
// cannot be reached.
func (l *Limiter) Allow(ctx context.Context, name, key string, r Rate) (Result, error) {
	if !r.Enabled() || key == "" {
		return Result{Allowed: true, Remaining: math.MaxInt}, nil
	}
	if l.client == nil {
		return Result{}, ErrUnavailable
	}
	args := []string{
		strconv.FormatInt(r.Window.Microseconds(), 10),
		strconv.Itoa(r.Limit),
		rand.Text(),
	}
	v, err := slidingWindow.Exec(ctx, l.client, []string{redisKey(name, key)}, args).AsIntSlice()
	if err != nil {
		return Result{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if len(v) != 3 {
		return Result{}, fmt.Errorf("%w: unexpected script reply %v", ErrUnavailable, v)
	}
	return Result{
		Allowed:    v[0] == 1,
		Remaining:  int(v[1]),
		RetryAfter: time.Duration(v[2]) * time.Microsecond,
	}, nil
}

// redisKey hashes the subject so emails and IPs are not stored in clear and
// key length stays bounded.
func redisKey(name, key string) string {
	sum := sha256.Sum256([]byte(key))
	return keyPrefix + name + ":" + hex.EncodeToString(sum[:])
}

// Check is Allow for use inside a handler, e.g. for a subject that is only
// known once the body is parsed (the email of an email-start request). It
// returns nil when admitted, a 429 with Retry-After when limited and a 503
// when Valkey is unavailable.
func (l *Limiter) Check(ctx context.Context, name, key string, r Rate) error {
	res, err := l.Allow(ctx, name, key, r)
	if err != nil {
		l.logUnavailable(name, err)
		return huma.Error503ServiceUnavailable(unavailableMsg)
	}
	if !res.Allowed {
		return huma.ErrorWithHeaders(huma.Error429TooManyRequests(limitedMsg),
			http.Header{"Retry-After": {retryAfter(res.RetryAfter)}})
	}
	return nil
}

const (
	limitedMsg     = "too many requests, retry later"
	unavailableMsg = "rate limiter unavailable, retry later"
)

// KeyFunc extracts the per-subject key (a user ID, an email) from a request.
// An empty key skips the per-key limit.
type KeyFunc func(huma.Context) string

// Key is a per-subject limit: Rate applies to each distinct value of From.
type Key struct {
	Rate Rate
	From KeyFunc
}

// Limit returns a Huma operation middleware enforcing limit name per client
// IP and, when perKey has a Rate and a From, per subject. Attach it through
// huma.Operation.Middlewares. A disabled Rate skips that dimension. Limited
// requests get 429 with Retry-After; when Valkey is unavailable they get 503.
// Subjects only known after body parsing use Check in the handler instead.
func (l *Limiter) Limit(api huma.API, name string, perIP Rate, perKey Key) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if perIP.Enabled() {
			if !l.enforce(api, ctx, name+":ip", ipKey(l.ClientIP(ctx)), perIP) {
				return
			}
		}
		if perKey.Rate.Enabled() && perKey.From != nil {
			if !l.enforce(api, ctx, name+":key", normalizeKey(perKey.From(ctx)), perKey.Rate) {
				return
			}
		}
		next(ctx)
	}
}

// enforce writes the error response and returns false when the request must
// not proceed.
func (l *Limiter) enforce(api huma.API, ctx huma.Context, name, key string, r Rate) bool {
	res, err := l.Allow(ctx.Context(), name, key, r)
	if err != nil {
		l.logUnavailable(name, err)
		_ = huma.WriteErr(api, ctx, http.StatusServiceUnavailable, unavailableMsg)
		return false
	}
	if !res.Allowed {
		ctx.SetHeader("Retry-After", retryAfter(res.RetryAfter))
		_ = huma.WriteErr(api, ctx, http.StatusTooManyRequests, limitedMsg)
		return false
	}
	return true
}

// normalizeKey makes per-subject keys case- and whitespace-insensitive so
// "A@x.com " and "a@x.com" share a bucket.
func normalizeKey(k string) string { return strings.ToLower(strings.TrimSpace(k)) }

// retryAfter renders d as whole seconds, rounded up, at least 1.
func retryAfter(d time.Duration) string {
	s := int64(math.Ceil(d.Seconds()))
	return strconv.FormatInt(max(s, 1), 10)
}

// logUnavailable logs a backend failure at most once per logEvery.
func (l *Limiter) logUnavailable(name string, err error) {
	now := l.now().UnixNano()
	last := l.lastLog.Load()
	if last != 0 && now-last < int64(logEvery) {
		return
	}
	if !l.lastLog.CompareAndSwap(last, now) {
		return
	}
	l.logger.Error("rate limiter unavailable; refusing limited requests (fail closed)", "limit", name, "error", err)
}

// ClientIP resolves the client address. X-Forwarded-For is walked from the
// right, skipping trusted proxies, and believed only when the TCP peer is a
// trusted proxy; otherwise anyone could pick a fresh IP per request.
func (l *Limiter) ClientIP(ctx huma.Context) netip.Addr {
	ip := parseAddr(ctx.RemoteAddr())
	if !ip.IsValid() || !l.trusted(ip) {
		return ip
	}
	var hops []string
	ctx.EachHeader(func(name, value string) {
		if strings.EqualFold(name, "X-Forwarded-For") {
			hops = append(hops, strings.Split(value, ",")...)
		}
	})
	for i := len(hops) - 1; i >= 0; i-- {
		hop := parseAddr(strings.TrimSpace(hops[i]))
		if !hop.IsValid() {
			return ip
		}
		ip = hop
		if !l.trusted(ip) {
			return ip
		}
	}
	return ip
}

func (l *Limiter) trusted(ip netip.Addr) bool {
	for _, p := range l.proxies {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// parseAddr accepts "ip", "ip:port" and "[ipv6]:port".
func parseAddr(s string) netip.Addr {
	if host, _, err := net.SplitHostPort(s); err == nil {
		s = host
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap().WithZone("")
}

// ipKey buckets IPv6 clients by /64, the smallest block a host usually
// controls, so rotating addresses inside it does not reset the limit.
func ipKey(ip netip.Addr) string {
	if !ip.IsValid() {
		return "unknown"
	}
	if ip.Is6() {
		p, _ := ip.Prefix(64)
		return p.String()
	}
	return ip.String()
}
