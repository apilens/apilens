//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Pace and phases of every failure drill, per example app.
const (
	// Requests per second per app. Three apps stay far below the CI
	// stack's 2000 records per minute quota, so the edge never sends a 429
	// of its own.
	drillRate     = 2
	drillBaseline = 20 * time.Second // proxy forwarding, before the fault
	// Pause between the baseline and the fault: longer than the SDKs' 3 s
	// flush interval, so the baseline is delivered before ingest fails.
	drillDrain = 5 * time.Second
	// Longer than any SDK's retry budget (3 retries with backoff capped at
	// 5 s, or 3 Retry-After waits), so the fault must drop batches.
	drillFault    = 25 * time.Second
	drillRecovery = 15 * time.Second // proxy forwarding again
	// Retry-After of the 429 drill, in seconds.
	drillRetryAfter = 2
	// Heartbeats come every 60 s; one that failed during the fault is sent
	// again a full interval later. Two intervals and some margin.
	drillSettle = 180 * time.Second
)

// TestIngestFailureDrills runs the failure drills (`task test:e2e:drills`)
// through each SDK's example app: a fault proxy (faultproxy_test.go) sits
// between the apps' SDKs and the ingest edge, and each drill
//
//   - ingest down: connections refused,
//   - ingest 5xx: every request answered 503,
//   - ingest 429: every request answered 429 with Retry-After: 2,
//
// drives steady traffic through every app before, during and after a 25 s
// fault, then checks that
//
//   - the app is unaffected: every response is 200 and p99 latency during
//     the fault stays within max(2 x, +APILENS_E2E_DRILL_P99_SLACK) of the
//     baseline p99 (default slack 100ms);
//   - drops are counted: the SDK stats the heartbeats report (GET
//     /api/v1/apps/{id}/status) grew by at least the requests that never
//     arrived, with retries_exhausted among the reasons;
//   - recovery flushes without duplicates: everything sent before and after
//     the fault arrives, no request is stored twice and no batch is
//     accepted twice; in the 429 drill the batches queued during the fault
//     arrive after it, and every retry after a 429 waited Retry-After.
//
// The apps must send to the proxy and use an environment no other traffic
// uses:
//
//	APILENS_EXAMPLES_INGEST_URL=http://host.docker.internal:18090/v1
//	APILENS_EXAMPLES_ENVIRONMENT=$APILENS_E2E_DRILLS_ENV
//	APILENS_E2E_DRILLS_ENV=e2e-drills-...
//	APILENS_E2E_DRILL_PROXY_ADDR=0.0.0.0:18090  (default; the proxy forwards to APILENS_E2E_BASE_URL)
//
// Besides the APILENS_E2E_* variables of ingest_e2e_test.go (the read key is
// required) it reads APILENS_E2E_EXAMPLES and APILENS_E2E_EXAMPLE_APPS as
// privacy_e2e_test.go does.
func TestIngestFailureDrills(t *testing.T) {
	envName := os.Getenv("APILENS_E2E_DRILLS_ENV")
	if envName == "" {
		t.Skip("APILENS_E2E_DRILLS_ENV not set; run `task test:e2e:drills`")
	}
	e := loadEnv(t)
	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Fatal("APILENS_E2E_READ_KEY not set; the drills read SDK stats from /api/v1/apps/{id}/status")
	}
	bases := splitList(os.Getenv("APILENS_E2E_EXAMPLES"))
	if len(bases) == 0 {
		t.Fatal("APILENS_E2E_EXAMPLES not set; list the example app URLs (`task examples:up`)")
	}
	apps := splitList(envOr("APILENS_E2E_EXAMPLE_APPS", "example-fastapi,example-express,example-spring"))
	if len(apps) != len(bases) {
		t.Fatalf("APILENS_E2E_EXAMPLE_APPS has %d apps for %d APILENS_E2E_EXAMPLES URLs", len(apps), len(bases))
	}
	slack, err := time.ParseDuration(envOr("APILENS_E2E_DRILL_P99_SLACK", "100ms"))
	if err != nil {
		t.Fatalf("APILENS_E2E_DRILL_P99_SLACK: %v", err)
	}

	proxy, err := newFaultProxy(envOr("APILENS_E2E_DRILL_PROXY_ADDR", "0.0.0.0:18090"), e.base)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = proxy.Close() }()
	t.Logf("fault proxy on %s, forwarding to %s", proxy.Addr(), e.base)

	ids := e.appIDs(t, readKey)
	for _, app := range apps {
		if ids[app] == "" {
			t.Fatalf("app %s not in the read key's project; seed it with `task examples:up`", app)
		}
		if n := e.count(t, fmt.Sprintf("SELECT count() FROM api_requests WHERE app_id = '%s' AND environment = '%s'", ids[app], envName)); n != 0 {
			t.Fatalf("%s: environment %q already has %d requests; use a fresh APILENS_E2E_DRILLS_ENV", app, envName, n)
		}
	}
	// The apps' first heartbeat may have gone out before the proxy listened;
	// wait for one through it, then warm the apps up.
	d := drillRun{e: e, t: t, readKey: readKey, envName: envName, proxy: proxy, bases: bases, apps: apps, ids: ids, slack: slack,
		client: &http.Client{Timeout: 15 * time.Second}, nextID: new(atomic.Int64)}
	d.awaitReporting()
	d.paced(5 * time.Second)

	for _, dr := range []struct {
		name       string
		mode       faultMode
		retryAfter int
	}{
		{"ingest down", faultDown, 0},
		{"ingest 5xx", faultServerError, 0},
		{"ingest 429 with Retry-After", faultRateLimited, drillRetryAfter},
	} {
		t.Run(dr.name, func(t *testing.T) {
			sub := d
			sub.t = t
			sub.drill(dr.mode, dr.retryAfter)
		})
	}
}

// drillRun holds what every drill shares.
type drillRun struct {
	e       env
	t       *testing.T
	readKey string
	envName string
	proxy   *faultProxy
	bases   []string
	apps    []string
	ids     map[string]string // slug -> app id
	slack   time.Duration
	client  *http.Client
	nextID  *atomic.Int64 // last order id sent, shared by every drill
}

// phaseResult is one app's traffic in one phase.
type phaseResult struct {
	sent      int
	latencies []time.Duration
	failures  []string
}

// phase is the traffic of one phase: order ids in [from, to) across apps.
type phase struct {
	from, to   int64
	start, end time.Time
	apps       map[string]*phaseResult
}

// sdkCounters sums the SDK stats of an app's instances in the drill
// environment, as their last heartbeats reported them.
type sdkCounters struct {
	instances []string
	oldest    time.Time // the least recent heartbeat among them
	queued    int64
	dropped   int64
	drops     map[string]int64
}

func (d *drillRun) drill(mode faultMode, retryAfter int) {
	t := d.t
	before := map[string]sdkCounters{}
	for _, app := range d.apps {
		before[app] = d.counters(app)
	}

	base := d.paced(drillBaseline)
	time.Sleep(drillDrain)
	if err := d.proxy.set(mode, retryAfter); err != nil {
		t.Fatal(err)
	}
	fault := d.paced(drillFault)
	if err := d.proxy.set(faultNone, 0); err != nil {
		t.Fatal(err)
	}
	rec := d.paced(drillRecovery)

	// 1. The app is unaffected while ingest fails.
	for _, app := range d.apps {
		b, f := base.apps[app], fault.apps[app]
		if len(f.failures) > 0 {
			t.Errorf("%s: %d of %d requests failed during the fault, first: %s", app, len(f.failures), f.sent, f.failures[0])
		}
		bp, fp := p99(b.latencies), p99(f.latencies)
		limit := max(2*bp, bp+d.slack)
		t.Logf("%s: p99 %v baseline, %v during the fault (limit %v); p50 %v / %v",
			app, bp, fp, limit, quantile(b.latencies, 0.5), quantile(f.latencies, 0.5))
		if fp > limit {
			t.Errorf("%s: p99 latency %v during the fault, baseline %v (limit %v)", app, fp, bp, limit)
		}
	}

	// 2. Let every SDK drain and report: a heartbeat after the traffic
	// stopped with nothing left queued, and stored rows that stopped moving.
	after := d.settle(rec.end)

	attempts := d.proxy.attemptsBetween(base.start, time.Now())
	if dups := duplicateDeliveries(attempts); len(dups) > 0 {
		t.Errorf("%d batches accepted by the edge more than once: %v", len(dups), dups)
	}
	for _, app := range d.apps {
		id := d.ids[app]
		sent := base.apps[app].sent + fault.apps[app].sent + rec.apps[app].sent
		rows, uniq := d.stored(id, base.from, rec.to)
		if rows != uniq {
			t.Errorf("%s: %d request rows for %d distinct requests: recovery stored duplicates", app, rows, uniq)
		}
		if n, _ := d.stored(id, base.from, base.to); n != base.apps[app].sent {
			t.Errorf("%s: %d of %d requests before the fault arrived", app, n, base.apps[app].sent)
		}
		if n, _ := d.stored(id, rec.from, rec.to); n != rec.apps[app].sent {
			t.Errorf("%s: %d of %d requests after the fault arrived", app, n, rec.apps[app].sent)
		}
		inFault, _ := d.stored(id, fault.from, fault.to)

		// 3. Every lost request is counted as a drop, with the reason.
		lost := int64(sent - uniq)
		b, a := before[app], after[app]
		if !slices.Equal(a.instances, b.instances) {
			t.Errorf("%s: SDK instances changed during the drill (%v -> %v): did the app restart?", app, b.instances, a.instances)
		}
		dropped := a.dropped - b.dropped
		reasons := map[string]int64{}
		for r, n := range a.drops {
			if delta := n - b.drops[r]; delta > 0 {
				reasons[r] = delta
			}
		}
		t.Logf("%s: sent %d, stored %d (%d of %d from the fault), lost %d; SDK dropped %d more: %v",
			app, sent, uniq, inFault, fault.apps[app].sent, lost, dropped, reasons)
		if lost > dropped {
			t.Errorf("%s: %d requests never arrived but the SDK stats count only %d drops", app, lost, dropped)
		}
		if reasons["retries_exhausted"] == 0 {
			t.Errorf("%s: no retries_exhausted drops counted for a %v fault (drops by reason: %v)", app, drillFault, reasons)
		}

		switch mode {
		case faultServerError, faultRateLimited:
			tried := 0
			for _, at := range attempts {
				if at.isBatch() && at.App == app && at.Mode == mode {
					tried++
				}
			}
			if tried == 0 {
				t.Errorf("%s: the SDK sent no batch during the %s fault", app, mode)
			}
		}
		if mode == faultRateLimited {
			// The batches held back by Retry-After are delivered once
			// ingest answers again.
			if inFault == 0 {
				t.Errorf("%s: none of the %d requests sent during the 429 fault arrived after it", app, fault.apps[app].sent)
			}
			gaps := retryGapsAfter429(attempts, app)
			if len(gaps) == 0 {
				t.Errorf("%s: no batch was retried after a 429", app)
			}
			wait := time.Duration(retryAfter)*time.Second - 100*time.Millisecond
			for _, g := range gaps {
				if g < wait {
					t.Errorf("%s: a batch was retried %v after a 429 with Retry-After: %d", app, g, retryAfter)
					break
				}
			}
		}
	}
}

// paced sends drillRate GET /orders/{id} per second to every app for dur,
// one request at a time per app, each with a fresh order id.
func (d *drillRun) paced(dur time.Duration) phase {
	ph := phase{from: d.nextID.Load() + 1, start: time.Now(), apps: map[string]*phaseResult{}}
	var wg sync.WaitGroup
	for i, app := range d.apps {
		res := &phaseResult{}
		ph.apps[app] = res
		wg.Add(1)
		go func(base string) {
			defer wg.Done()
			tick := time.NewTicker(time.Second / drillRate)
			defer tick.Stop()
			stop := time.After(dur)
			for {
				select {
				case <-stop:
					return
				case <-tick.C:
				}
				u := base + "/orders/" + strconv.FormatInt(d.nextID.Add(1), 10)
				res.sent++
				start := time.Now()
				req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
				resp, err := d.client.Do(req)
				if err != nil {
					res.failures = append(res.failures, err.Error())
					continue
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				res.latencies = append(res.latencies, time.Since(start))
				if resp.StatusCode != http.StatusOK {
					res.failures = append(res.failures, fmt.Sprintf("GET %s: status %d", u, resp.StatusCode))
				}
			}
		}(d.bases[i])
	}
	wg.Wait()
	ph.to, ph.end = d.nextID.Load()+1, time.Now()
	return ph
}

// counters reads app's SDK stats in the drill environment.
func (d *drillRun) counters(app string) sdkCounters {
	var st struct {
		Instances []struct {
			Environment string         `json:"environment"`
			InstanceID  string         `json:"instance_id"`
			Status      string         `json:"status"`
			Stats       map[string]any `json:"stats"`
			LastSeenAt  time.Time      `json:"last_seen_at"`
		} `json:"instances"`
	}
	d.e.getJSON(d.t, d.readKey, "/api/v1/apps/"+d.ids[app]+"/status", &st)
	c := sdkCounters{drops: map[string]int64{}}
	for _, in := range st.Instances {
		if in.Environment != d.envName || in.Status != "reporting" {
			continue
		}
		c.instances = append(c.instances, in.InstanceID)
		if c.oldest.IsZero() || in.LastSeenAt.Before(c.oldest) {
			c.oldest = in.LastSeenAt
		}
		c.queued += statNumber(in.Stats["queued_records"])
		c.dropped += statNumber(in.Stats["dropped"])
		if m, ok := in.Stats["drop_counts"].(map[string]any); ok {
			for r, v := range m {
				c.drops[r] += statNumber(v)
			}
		}
	}
	slices.Sort(c.instances)
	return c
}

func statNumber(v any) int64 {
	f, ok := v.(float64)
	if !ok || f < 0 || math.IsNaN(f) {
		return 0
	}
	return int64(f)
}

// awaitReporting waits until every app has an instance reporting in the
// drill environment.
func (d *drillRun) awaitReporting() {
	deadline := time.Now().Add(drillSettle)
	for _, app := range d.apps {
		for len(d.counters(app).instances) == 0 {
			if time.Now().After(deadline) {
				d.t.Fatalf("%s: no SDK heartbeat in environment %s through the fault proxy; do the apps send to %s?",
					app, d.envName, d.proxy.Addr())
			}
			time.Sleep(2 * time.Second)
		}
	}
}

// settle waits until every app's SDK sent a heartbeat after since with an
// empty queue and the drill environment's stored rows stopped changing, and
// returns the counters of that heartbeat.
func (d *drillRun) settle(since time.Time) map[string]sdkCounters {
	deadline := time.Now().Add(drillSettle)
	out := map[string]sdkCounters{}
	for _, app := range d.apps {
		for {
			c := d.counters(app)
			if len(c.instances) > 0 && c.oldest.After(since) && c.queued == 0 {
				out[app] = c
				break
			}
			if time.Now().After(deadline) {
				d.t.Fatalf("%s: no heartbeat with an empty queue since %s (last: %+v)", app, since.Format(time.RFC3339), c)
			}
			time.Sleep(2 * time.Second)
		}
	}
	q := fmt.Sprintf("SELECT count() FROM api_requests WHERE environment = '%s'", d.envName)
	last := -1
	for {
		n := d.e.count(d.t, q)
		if n == last {
			return out
		}
		if time.Now().After(deadline) {
			d.t.Fatalf("stored requests in %s still changing (%d -> %d)", d.envName, last, n)
		}
		last = n
		time.Sleep(2 * time.Second)
	}
}

// stored counts app's request rows (and distinct requests) with an order id
// in [from, to).
func (d *drillRun) stored(appID string, from, to int64) (rows, distinct int) {
	where := fmt.Sprintf("FROM api_requests WHERE app_id = '%s' AND environment = '%s' "+
		"AND toInt64OrZero(extract(raw_path, '^/orders/([0-9]+)$')) BETWEEN %d AND %d", appID, d.envName, from, to-1)
	return d.e.count(d.t, "SELECT count() "+where), d.e.count(d.t, "SELECT uniqExact(raw_path) "+where)
}

func p99(xs []time.Duration) time.Duration { return quantile(xs, 0.99) }

// quantile is the nearest-rank q-quantile of xs (0 for none).
func quantile(xs []time.Duration, q float64) time.Duration {
	if len(xs) == 0 {
		return 0
	}
	s := slices.Clone(xs)
	slices.Sort(s)
	i := int(math.Ceil(q*float64(len(s)))) - 1
	return s[max(i, 0)]
}
