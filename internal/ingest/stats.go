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

// Per-app ingest health counters. The edge counts what it did to the records
// of each app per UTC day, next to (and at the same points as) the
// Prometheus totals:
//
//   - accepted:  records stored (apilens_ingest_records_total{result="accepted"})
//   - rejected:  records refused by the project quota or dropped as invalid
//     from an OTLP export (apilens_ingest_records_total{result="rejected"})
//   - truncated: request record fields cut to the server-side cap
//     (apilens_ingest_truncated_total)
//   - masked:    records in which the server-side privacy policy masked at
//     least one value (apilens_ingest_masked_total)
//
// Records not tied to a known app (project-wide deploys, OTLP resources of
// unknown services) count in Prometheus only.

const (
	// StatsKeyPrefix prefixes the per app and day counter hash:
	// StatsKeyPrefix + "<app id>:<YYYY-MM-DD>".
	StatsKeyPrefix = "apilens:ingest:stats:"
	// StatsRetentionDays is how many UTC days, today included, of counters
	// are kept.
	StatsRetentionDays = 30

	// statsTTL outlives the retention so the oldest day is whole.
	statsTTL = (StatsRetentionDays + 1) * 24 * time.Hour
	// statsWriteTimeout bounds the counter write of one ingest call.
	statsWriteTimeout = time.Second
	// statsLogEvery bounds how often an unavailable stats backend is logged.
	statsLogEvery = time.Minute
)

// Counter fields of the per app and day hash.
const (
	statAccepted  = "accepted"
	statRejected  = "rejected"
	statTruncated = "truncated"
	statMasked    = "masked"
)

// Counts are the ingest health counters of one app over some period.
type Counts struct {
	Accepted  int64
	Rejected  int64
	Truncated int64
	Masked    int64
}

// Add returns the field-wise sum of c and o.
func (c Counts) Add(o Counts) Counts {
	return Counts{c.Accepted + o.Accepted, c.Rejected + o.Rejected, c.Truncated + o.Truncated, c.Masked + o.Masked}
}

func (c Counts) fields() [4]struct {
	name string
	n    int64
} {
	return [4]struct {
		name string
		n    int64
	}{{statAccepted, c.Accepted}, {statRejected, c.Rejected}, {statTruncated, c.Truncated}, {statMasked, c.Masked}}
}

// StatsStore keeps the per app and day counters.
type StatsStore interface {
	// Add adds deltas to the counters of each app on the UTC day of day.
	Add(ctx context.Context, day time.Time, deltas map[uuid.UUID]Counts) error
}

// WithStats makes the edge keep per app and day health counters in store;
// nil keeps Prometheus totals only.
func (e *Edge) WithStats(store StatsStore) *Edge {
	e.stats = store
	return e
}

// tally collects the per-app counter deltas of one ingest call.
type tally map[uuid.UUID]*Counts

// app returns the counters of appID; records without an app go to a
// throwaway value.
func (t tally) app(appID uuid.UUID) *Counts {
	if appID == uuid.Nil {
		return &Counts{}
	}
	c, ok := t[appID]
	if !ok {
		c = &Counts{}
		t[appID] = c
	}
	return c
}

// flushStats writes a call's deltas. It fails open: counters are
// observability, never a reason to refuse telemetry, and an outage is logged
// at most once a minute.
func (e *Edge) flushStats(ctx context.Context, t tally) {
	if e.stats == nil || len(t) == 0 {
		return
	}
	deltas := make(map[uuid.UUID]Counts, len(t))
	for id, c := range t {
		if *c != (Counts{}) {
			deltas[id] = *c
		}
	}
	if len(deltas) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), statsWriteTimeout)
	defer cancel()
	if err := e.stats.Add(ctx, e.now(), deltas); err != nil {
		now := e.now().UnixNano()
		last := e.statsLog.Load()
		if (last == 0 || now-last >= int64(statsLogEvery)) && e.statsLog.CompareAndSwap(last, now) {
			e.logger.Warn("ingest stats unavailable; per-app counters not updated", "error", err)
		}
	}
}

// rejectRecords counts the records of a call refused as a whole (quota). It
// attributes them to their apps on a best-effort basis: an identifier that
// does not resolve is counted in Prometheus only.
func (e *Edge) rejectRecords(ctx context.Context, projectID uuid.UUID, signal string, idents []string, t tally) {
	e.records.WithLabelValues(signal, "rejected").Add(float64(len(idents)))
	distinct := map[string]bool{}
	var lookup []string
	for i, id := range idents {
		id = strings.TrimSpace(id)
		idents[i] = id
		if id != "" && !distinct[id] {
			distinct[id] = true
			lookup = append(lookup, id)
		}
	}
	if len(lookup) == 0 {
		return
	}
	apps, err := e.apps.Resolve(ctx, projectID, lookup)
	if err != nil {
		return
	}
	for _, id := range idents {
		if appID, ok := apps[id]; ok {
			t.app(appID).Rejected++
		}
	}
}

// ValkeyStats is the StatsStore over Valkey, shared by every edge replica
// and read by the query role.
type ValkeyStats struct {
	client valkey.Client
}

// NewValkeyStats returns a StatsStore over client.
func NewValkeyStats(client valkey.Client) *ValkeyStats {
	return &ValkeyStats{client: client}
}

func statsKey(appID uuid.UUID, day time.Time) string {
	return StatsKeyPrefix + appID.String() + ":" + day.UTC().Format(time.DateOnly)
}

// Add implements StatsStore.
func (v *ValkeyStats) Add(ctx context.Context, day time.Time, deltas map[uuid.UUID]Counts) error {
	cmds := make(valkey.Commands, 0, 5*len(deltas))
	for appID, c := range deltas {
		key := statsKey(appID, day)
		for _, f := range c.fields() {
			if f.n != 0 {
				cmds = append(cmds, v.client.B().Hincrby().Key(key).Field(f.name).Increment(f.n).Build())
			}
		}
		cmds = append(cmds, v.client.B().Expire().Key(key).Seconds(int64(statsTTL.Seconds())).Build())
	}
	for _, res := range v.client.DoMulti(ctx, cmds...) {
		if err := res.Error(); err != nil {
			return fmt.Errorf("ingest stats: %w", err)
		}
	}
	return nil
}

// Days returns the counters of appID on each UTC day of days, in order; a
// day without traffic is all zero.
func (v *ValkeyStats) Days(ctx context.Context, appID uuid.UUID, days []time.Time) ([]Counts, error) {
	cmds := make(valkey.Commands, len(days))
	for i, d := range days {
		cmds[i] = v.client.B().Hmget().Key(statsKey(appID, d)).Field(statAccepted, statRejected, statTruncated, statMasked).Build()
	}
	out := make([]Counts, len(days))
	for i, res := range v.client.DoMulti(ctx, cmds...) {
		vals, err := res.ToArray()
		if err != nil {
			return nil, fmt.Errorf("ingest stats: %w", err)
		}
		n := make([]int64, 4)
		for j := range min(len(vals), 4) {
			s, err := vals[j].ToString()
			if valkey.IsValkeyNil(err) {
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("ingest stats: %w", err)
			}
			if n[j], err = strconv.ParseInt(s, 10, 64); err != nil {
				return nil, fmt.Errorf("ingest stats: %w", err)
			}
		}
		out[i] = Counts{Accepted: n[0], Rejected: n[1], Truncated: n[2], Masked: n[3]}
	}
	return out, nil
}
