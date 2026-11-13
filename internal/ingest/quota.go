package ingest

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/platform/config"
)

// Rejection reasons, the `reason` label of apilens_ingest_rejected_total.
const (
	ReasonRecordsPerMinute = "records_per_minute"
	ReasonBytesPerDay      = "bytes_per_day"
)

// Quota admits a batch against a project's ingest limits.
type Quota interface {
	// Admit charges records and bytes to the project. When the batch does not
	// fit, nothing is charged and the decision says which limit refused it and
	// when it would fit.
	Admit(ctx context.Context, projectID uuid.UUID, records, bytes int64) (QuotaDecision, error)
}

// QuotaDecision is the outcome of one Admit call.
type QuotaDecision struct {
	Allowed bool
	// Reason is the refusing limit (ReasonRecordsPerMinute, ReasonBytesPerDay).
	Reason string
	// RetryAfter is how long until the batch would fit; zero when Allowed.
	RetryAfter time.Duration
}

const quotaKeyPrefix = "apilens:ingest:quota:"

// tokenBuckets charges ARGV-described costs to every bucket in KEYS, all or
// nothing. Per key ARGV holds capacity, refill period (ms, the time to refill
// from empty) and cost. A bucket starts full and refills linearly at
// capacity/period. A cost above capacity (one OTLP export larger than the
// whole budget) is charged as the full bucket, so it waits for a full refill
// instead of never fitting. Returns {1, 0, 0} when admitted, otherwise
// {0, index of the bucket with the longest wait (1-based), wait in ms}.
// Valkey's clock is used so replicas share one timeline.
var tokenBuckets = valkey.NewLuaScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tokens = {}
local wait, reason = 0, 0
for i = 1, #KEYS do
  local cap = tonumber(ARGV[i*3-2])
  local period = tonumber(ARGV[i*3-1])
  local cost = math.min(tonumber(ARGV[i*3]), cap)
  local h = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tok, ts = tonumber(h[1]), tonumber(h[2])
  if tok == nil or ts == nil then tok, ts = cap, now end
  if now > ts then tok = math.min(cap, tok + (now - ts) * cap / period) end
  tokens[i] = tok
  if tok < cost then
    local w = math.ceil((cost - tok) * period / cap)
    if w > wait then wait, reason = w, i end
  end
end
if reason > 0 then return {0, reason, wait} end
for i = 1, #KEYS do
  local period = tonumber(ARGV[i*3-1])
  local cost = math.min(tonumber(ARGV[i*3]), tonumber(ARGV[i*3-2]))
  redis.call('HSET', KEYS[i], 'tokens', string.format('%.6f', tokens[i] - cost), 'ts', string.format('%d', now))
  redis.call('PEXPIRE', KEYS[i], string.format('%d', period))
end
return {1, 0, 0}
`)

// bucket is one limit: Capacity units refilled over Period.
type bucket struct {
	reason   string
	capacity int64
	period   time.Duration
}

// ValkeyQuota enforces config.QuotaConfig with token buckets in Valkey, so
// every edge replica shares one budget per project.
type ValkeyQuota struct {
	client  valkey.Client
	buckets []bucket
}

// NewValkeyQuota returns a quota over client for the limits in cfg. A limit
// of zero is not enforced.
func NewValkeyQuota(client valkey.Client, cfg config.QuotaConfig) *ValkeyQuota {
	q := &ValkeyQuota{client: client}
	if cfg.RecordsPerMinute > 0 {
		q.buckets = append(q.buckets, bucket{ReasonRecordsPerMinute, cfg.RecordsPerMinute, time.Minute})
	}
	if cfg.BytesPerDay > 0 {
		q.buckets = append(q.buckets, bucket{ReasonBytesPerDay, cfg.BytesPerDay, 24 * time.Hour})
	}
	return q
}

// Admit implements Quota.
func (q *ValkeyQuota) Admit(ctx context.Context, projectID uuid.UUID, records, bytes int64) (QuotaDecision, error) {
	if len(q.buckets) == 0 {
		return QuotaDecision{Allowed: true}, nil
	}
	keys := make([]string, len(q.buckets))
	args := make([]string, 0, 3*len(q.buckets))
	for i, b := range q.buckets {
		cost := records
		if b.reason == ReasonBytesPerDay {
			cost = bytes
		}
		keys[i] = quotaKeyPrefix + b.reason + ":" + projectID.String()
		args = append(args, strconv.FormatInt(b.capacity, 10), strconv.FormatInt(b.period.Milliseconds(), 10), strconv.FormatInt(cost, 10))
	}
	v, err := tokenBuckets.Exec(ctx, q.client, keys, args).AsIntSlice()
	if err != nil {
		return QuotaDecision{}, fmt.Errorf("ingest quota: %w", err)
	}
	if len(v) != 3 {
		return QuotaDecision{}, fmt.Errorf("ingest quota: unexpected script reply %v", v)
	}
	if v[0] == 1 {
		return QuotaDecision{Allowed: true}, nil
	}
	i := int(v[1]) - 1
	if i < 0 || i >= len(q.buckets) {
		return QuotaDecision{}, fmt.Errorf("ingest quota: unexpected bucket index %d", v[1])
	}
	return QuotaDecision{Reason: q.buckets[i].reason, RetryAfter: time.Duration(v[2]) * time.Millisecond}, nil
}

// quotaLogEvery bounds how often an unavailable quota backend is logged.
const quotaLogEvery = time.Minute

// admit checks the project's quota for a batch and records the outcome in t
// (the admitted bytes, or the refusing limit). It fails open: when the
// quota backend does not answer the batch is accepted, so a Valkey outage
// never drops telemetry, and the outage is logged at most once a minute.
func (e *Edge) admit(ctx context.Context, projectID uuid.UUID, records, bytes int, t tally) *apiError {
	if e.quota == nil {
		t.charge(projectID, bytes)
		return nil
	}
	d, err := e.quota.Admit(ctx, projectID, int64(records), int64(bytes))
	if err != nil {
		e.logQuotaUnavailable(err)
		t.charge(projectID, bytes)
		return nil
	}
	if d.Allowed {
		t.charge(projectID, bytes)
		return nil
	}
	t.refuse(projectID, d.Reason)
	e.rejected.WithLabelValues(d.Reason).Inc()
	return &apiError{
		status:     http.StatusTooManyRequests,
		Code:       "quota_exceeded",
		Detail:     fmt.Sprintf("Project ingest quota exceeded (%s), retry later", d.Reason),
		retryAfter: max(d.RetryAfter, time.Second),
	}
}

func (e *Edge) logQuotaUnavailable(err error) {
	now := e.now().UnixNano()
	last := e.quotaLog.Load()
	if last != 0 && now-last < int64(quotaLogEvery) {
		return
	}
	if e.quotaLog.CompareAndSwap(last, now) {
		e.logger.Error("ingest quota unavailable; admitting batches unchecked (fail open)", "error", err)
	}
}

// retryAfterSeconds renders d as whole seconds, rounded up, at least 1.
func retryAfterSeconds(d time.Duration) string {
	return strconv.FormatInt(max(int64(math.Ceil(d.Seconds())), 1), 10)
}
