package ingest

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"
)

// Project usage breakdowns. Next to the per app and day counters (stats.go)
// the edge keeps, in the same app and day hash:
//
//   - rejected:<reason>: rejected records by reason, the quota limit
//     (ReasonRecordsPerMinute, ReasonBytesPerDay), the catalog's app refusal
//     (catalog.Rejection.Reason) or ReasonInvalid; they sum to rejected.
//   - env:<name>: accepted records by environment; they sum to accepted.
//
// and, per project and UTC day (UsageKeyPrefix), the decompressed body bytes
// of the ingest calls admitted, as charged to the bytes_per_day quota.
// Counters written before the breakdowns existed have no reason or
// environment fields.

const (
	// UsageKeyPrefix prefixes the per project and day usage hash:
	// UsageKeyPrefix + "<project id>:<YYYY-MM-DD>".
	UsageKeyPrefix = "apilens:ingest:usage:"
	// ReasonInvalid is the rejection reason of OTLP records dropped as
	// invalid (missing ids, out-of-range timestamps).
	ReasonInvalid = "invalid"

	statRejectedPrefix = "rejected:"
	statEnvPrefix      = "env:"
	usageBytes         = "bytes"
)

// Breakdown is the reason and environment split of one app's counters.
type Breakdown struct {
	// RejectedBy is rejected records by reason.
	RejectedBy map[string]int64
	// Environments is accepted records by environment.
	Environments map[string]int64
}

func (b *Breakdown) empty() bool { return len(b.RejectedBy) == 0 && len(b.Environments) == 0 }

func bump(m *map[string]int64, k string, n int64) {
	if *m == nil {
		*m = map[string]int64{}
	}
	(*m)[k] += n
}

// AppUsage is the counters of one app on one UTC day with their breakdown.
type AppUsage struct {
	Counts
	Breakdown
}

// UsageStore keeps the usage breakdowns; a StatsStore that also implements
// it (*ValkeyStats) gets them written by the edge.
type UsageStore interface {
	// AddUsage adds per-app breakdown deltas and the bytes of one project on
	// the UTC day of day.
	AddUsage(ctx context.Context, day time.Time, projectID uuid.UUID, bytes int64, deltas map[uuid.UUID]Breakdown) error
}

// appTally is the per-app deltas of one ingest call; the uuid.Nil entry of
// a tally holds the call's project and admitted bytes instead.
type appTally struct {
	Counts
	Breakdown
	project uuid.UUID
	bytes   int64
	reason  string // the quota limit that refused the call
}

// call returns the call-level entry of t.
func (t tally) call() *appTally {
	c, ok := t[uuid.Nil]
	if !ok {
		c = &appTally{}
		t[uuid.Nil] = c
	}
	return c
}

// charge records bytes admitted for projectID.
func (t tally) charge(projectID uuid.UUID, bytes int) {
	c := t.call()
	c.project, c.bytes = projectID, c.bytes+int64(bytes)
}

// refuse records the quota limit that refused the call.
func (t tally) refuse(projectID uuid.UUID, reason string) {
	c := t.call()
	c.project, c.reason = projectID, reason
}

// accept counts one stored record of appID in env.
func (t tally) accept(appID uuid.UUID, env string) {
	if appID == uuid.Nil {
		return
	}
	a := t.entry(appID)
	a.Accepted++
	bump(&a.Environments, env, 1)
}

// reject counts n records of appID refused for reason.
func (t tally) reject(appID uuid.UUID, reason string, n int64) {
	if appID == uuid.Nil || n == 0 {
		return
	}
	a := t.entry(appID)
	a.Rejected += n
	bump(&a.RejectedBy, reason, n)
}

func usageKey(projectID uuid.UUID, day time.Time) string {
	return UsageKeyPrefix + projectID.String() + ":" + day.UTC().Format(time.DateOnly)
}

// AddUsage implements UsageStore.
func (v *ValkeyStats) AddUsage(ctx context.Context, day time.Time, projectID uuid.UUID, bytes int64, deltas map[uuid.UUID]Breakdown) error {
	ttl := int64(statsTTL.Seconds())
	var cmds valkey.Commands
	for appID, b := range deltas {
		key := statsKey(appID, day)
		for reason, n := range b.RejectedBy {
			cmds = append(cmds, v.client.B().Hincrby().Key(key).Field(statRejectedPrefix+reason).Increment(n).Build())
		}
		for env, n := range b.Environments {
			cmds = append(cmds, v.client.B().Hincrby().Key(key).Field(statEnvPrefix+env).Increment(n).Build())
		}
		cmds = append(cmds, v.client.B().Expire().Key(key).Seconds(ttl).Build())
	}
	if bytes > 0 && projectID != uuid.Nil {
		key := usageKey(projectID, day)
		cmds = append(cmds,
			v.client.B().Hincrby().Key(key).Field(usageBytes).Increment(bytes).Build(),
			v.client.B().Expire().Key(key).Seconds(ttl).Build())
	}
	for _, res := range v.client.DoMulti(ctx, cmds...) {
		if err := res.Error(); err != nil {
			return fmt.Errorf("ingest usage: %w", err)
		}
	}
	return nil
}

// AppUsage returns the counters of appID with their breakdown on each UTC
// day of days, in order; a day without traffic is all zero.
func (v *ValkeyStats) AppUsage(ctx context.Context, appID uuid.UUID, days []time.Time) ([]AppUsage, error) {
	cmds := make(valkey.Commands, len(days))
	for i, d := range days {
		cmds[i] = v.client.B().Hgetall().Key(statsKey(appID, d)).Build()
	}
	out := make([]AppUsage, len(days))
	for i, res := range v.client.DoMulti(ctx, cmds...) {
		m, err := res.AsStrMap()
		if err != nil && !valkey.IsValkeyNil(err) {
			return nil, fmt.Errorf("ingest usage: %w", err)
		}
		u := &out[i]
		for field, s := range m {
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("ingest usage: field %s: %w", field, err)
			}
			switch {
			case field == statAccepted:
				u.Accepted = n
			case field == statRejected:
				u.Rejected = n
			case field == statTruncated:
				u.Truncated = n
			case field == statMasked:
				u.Masked = n
			case strings.HasPrefix(field, statRejectedPrefix):
				bump(&u.RejectedBy, strings.TrimPrefix(field, statRejectedPrefix), n)
			case strings.HasPrefix(field, statEnvPrefix):
				bump(&u.Environments, strings.TrimPrefix(field, statEnvPrefix), n)
			}
		}
	}
	return out, nil
}

// ProjectBytes returns the admitted bytes of projectID on each UTC day of
// days, in order.
func (v *ValkeyStats) ProjectBytes(ctx context.Context, projectID uuid.UUID, days []time.Time) ([]int64, error) {
	cmds := make(valkey.Commands, len(days))
	for i, d := range days {
		cmds[i] = v.client.B().Hget().Key(usageKey(projectID, d)).Field(usageBytes).Build()
	}
	out := make([]int64, len(days))
	for i, res := range v.client.DoMulti(ctx, cmds...) {
		n, err := res.AsInt64()
		if valkey.IsValkeyNil(err) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("ingest usage: %w", err)
		}
		out[i] = n
	}
	return out, nil
}
