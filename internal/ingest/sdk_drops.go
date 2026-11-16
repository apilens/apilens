package ingest

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"
)

// SDK drop counters (D7, #927). Every SDK counts the records it drops before
// they reach the edge (queue full, retries exhausted, ...) and reports the
// counts since its previous accepted heartbeat in the heartbeat's "dropped"
// field, per signal and reason. The edge adds them to a per app and UTC hour
// hash next to the ingest health counters; Ingest health shows them as
// "Dropped by the SDK" beside the server-side rejects.

const (
	// SDKDropKeyPrefix prefixes the per app and hour hash:
	// SDKDropKeyPrefix + "<app id>:<YYYY-MM-DDTHH>", with one field per
	// "<signal>|<reason>".
	SDKDropKeyPrefix = "apilens:ingest:sdk_drops:"

	// maxSDKDropReasons bounds the reasons of one signal in one heartbeat.
	maxSDKDropReasons = 32
	sdkDropHourFormat = "2006-01-02T15"
)

// SDKDropSignals are the signals an SDK reports drops for; other keys of the
// heartbeat's "dropped" field are ignored.
var SDKDropSignals = []string{"requests", "spans", "logs"}

// sdkDropReason is what a drop reason may look like: snake_case as the SDKs
// name them (queue_full, retries_exhausted, ...).
var sdkDropReason = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,63}$`)

// SDKDropKey is one signal and reason.
type SDKDropKey struct {
	Signal string
	Reason string
}

// SDKDrop is how many records of one signal the SDKs dropped for one reason.
type SDKDrop struct {
	SDKDropKey
	Records int64
}

// SDKDropStore keeps the per app and hour SDK drop counters. A StatsStore
// that implements it (*ValkeyStats) gets the heartbeat drops written.
type SDKDropStore interface {
	AddSDKDrops(ctx context.Context, appID uuid.UUID, hour time.Time, drops map[SDKDropKey]int64) error
}

// sdkDrops validates the heartbeat's "dropped" field: unknown signals and
// zero counts are left out, a malformed reason or a negative count is an
// error.
func sdkDrops(dropped map[string]map[string]int64) (map[SDKDropKey]int64, *apiError) {
	out := map[SDKDropKey]int64{}
	for signal, reasons := range dropped {
		known := false
		for _, s := range SDKDropSignals {
			known = known || s == signal
		}
		if !known {
			continue
		}
		if len(reasons) > maxSDKDropReasons {
			return nil, errValidation("dropped.%s has more than %d reasons", signal, maxSDKDropReasons)
		}
		for reason, n := range reasons {
			if !sdkDropReason.MatchString(reason) {
				return nil, errValidation("dropped.%s: reason %q must be lowercase letters, digits, '_', '.' or '-', at most 64 characters", signal, reason)
			}
			if n < 0 {
				return nil, errValidation("dropped.%s.%s must not be negative", signal, reason)
			}
			if n > 0 {
				out[SDKDropKey{signal, reason}] = n
			}
		}
	}
	return out, nil
}

// flushSDKDrops writes a heartbeat's drops. It fails open like the other
// health counters: an outage is logged, never a reason to refuse the
// heartbeat.
func (e *Edge) flushSDKDrops(ctx context.Context, appID uuid.UUID, drops map[SDKDropKey]int64) {
	store, ok := e.stats.(SDKDropStore)
	if !ok || len(drops) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), statsWriteTimeout)
	defer cancel()
	if err := store.AddSDKDrops(ctx, appID, e.now(), drops); err != nil {
		e.logger.Warn("SDK drop counters unavailable", "app_id", appID, "error", err)
	}
}

func sdkDropsKey(appID uuid.UUID, hour time.Time) string {
	return SDKDropKeyPrefix + appID.String() + ":" + hour.UTC().Format(sdkDropHourFormat)
}

// AddSDKDrops implements SDKDropStore: the drops count in the UTC hour of
// hour.
func (v *ValkeyStats) AddSDKDrops(ctx context.Context, appID uuid.UUID, hour time.Time, drops map[SDKDropKey]int64) error {
	key := sdkDropsKey(appID, hour)
	cmds := make(valkey.Commands, 0, len(drops)+1)
	for k, n := range drops {
		cmds = append(cmds, v.client.B().Hincrby().Key(key).Field(k.Signal+"|"+k.Reason).Increment(n).Build())
	}
	cmds = append(cmds, v.client.B().Expire().Key(key).Seconds(int64(statsTTL.Seconds())).Build())
	for _, res := range v.client.DoMulti(ctx, cmds...) {
		if err := res.Error(); err != nil {
			return fmt.Errorf("ingest SDK drops: %w", err)
		}
	}
	return nil
}

// SDKDrops returns the SDK drops of appID on each UTC day of days, in order,
// summed over the day's hours, most records first; a day without drops is
// empty.
func (v *ValkeyStats) SDKDrops(ctx context.Context, appID uuid.UUID, days []time.Time) ([][]SDKDrop, error) {
	cmds := make(valkey.Commands, 0, 24*len(days))
	for _, d := range days {
		start := d.UTC().Truncate(24 * time.Hour)
		for h := range 24 {
			cmds = append(cmds, v.client.B().Hgetall().Key(sdkDropsKey(appID, start.Add(time.Duration(h)*time.Hour))).Build())
		}
	}
	sums := make([]map[SDKDropKey]int64, len(days))
	for i, res := range v.client.DoMulti(ctx, cmds...) {
		m, err := res.AsStrMap()
		if err != nil && !valkey.IsValkeyNil(err) {
			return nil, fmt.Errorf("ingest SDK drops: %w", err)
		}
		day := i / 24
		for field, s := range m {
			signal, reason, ok := strings.Cut(field, "|")
			n, err := strconv.ParseInt(s, 10, 64)
			if !ok || err != nil || n <= 0 {
				continue
			}
			if sums[day] == nil {
				sums[day] = map[SDKDropKey]int64{}
			}
			sums[day][SDKDropKey{signal, reason}] += n
		}
	}
	out := make([][]SDKDrop, len(days))
	for i, m := range sums {
		out[i] = SortSDKDrops(m)
	}
	return out, nil
}

// SortSDKDrops lists m most records first, then by signal and reason.
func SortSDKDrops(m map[SDKDropKey]int64) []SDKDrop {
	out := make([]SDKDrop, 0, len(m))
	for k, n := range m {
		out = append(out, SDKDrop{k, n})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Records != b.Records {
			return a.Records > b.Records
		}
		if a.Signal != b.Signal {
			return a.Signal < b.Signal
		}
		return a.Reason < b.Reason
	})
	return out
}
