package ingest

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/platform/config"
)

// memSDKDrops is a StatsStore that also keeps SDK drops per app and hour.
type memSDKDrops struct {
	memStats
	mu    sync.Mutex
	err   error
	calls int
	hours map[string]map[SDKDropKey]int64 // "<app>|<hour>"
}

func (m *memSDKDrops) AddSDKDrops(_ context.Context, appID uuid.UUID, hour time.Time, drops map[SDKDropKey]int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	if m.err != nil {
		return m.err
	}
	if m.hours == nil {
		m.hours = map[string]map[SDKDropKey]int64{}
	}
	k := appID.String() + "|" + hour.UTC().Format(sdkDropHourFormat)
	if m.hours[k] == nil {
		m.hours[k] = map[SDKDropKey]int64{}
	}
	for d, n := range drops {
		m.hours[k][d] += n
	}
	return nil
}

func newDropsEdge(t *testing.T, stats StatsStore, src CaptureSource) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, &fakeSink{}, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	e.now = func() time.Time { return fixedNow }
	e.WithHeartbeat(&fakeHeartbeats{}, nil)
	if stats != nil {
		e.WithStats(stats)
	}
	if src != nil {
		e.WithCapture(src)
	}
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

func TestHeartbeatStoresSDKDropsPerAppAndHour(t *testing.T) {
	store := &memSDKDrops{}
	h := newDropsEdge(t, store, nil)
	body := `{"app_id":"storefront","instance_id":"i","dropped":{
	  "requests":{"queue_full":3,"retries_exhausted":0},
	  "spans":{"retries_exhausted":12},
	  "logs":{},
	  "profiles":{"queue_full":9}}}`
	if rec := post(t, h, "/v1/heartbeat", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if rec := post(t, h, "/v1/heartbeat", `{"app_id":"storefront","instance_id":"j","dropped":{"requests":{"queue_full":2}}}`, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	got := store.hours[testApp.String()+"|"+fixedNow.UTC().Format(sdkDropHourFormat)]
	want := map[SDKDropKey]int64{{"requests", "queue_full"}: 5, {"spans", "retries_exhausted"}: 12}
	if len(got) != len(want) || len(store.hours) != 1 {
		t.Fatalf("drops = %v (hours %v), want %v", got, store.hours, want)
	}
	for k, n := range want {
		if got[k] != n {
			t.Errorf("%v = %d, want %d", k, got[k], n)
		}
	}
}

func TestHeartbeatWithoutDropsWritesNothing(t *testing.T) {
	store := &memSDKDrops{}
	h := newDropsEdge(t, store, nil)
	for _, body := range []string{
		`{"app_id":"storefront","instance_id":"i"}`,
		`{"app_id":"storefront","instance_id":"j","dropped":{"requests":{"queue_full":0}}}`,
	} {
		if rec := post(t, h, "/v1/heartbeat", body, nil); rec.Code != http.StatusOK {
			t.Fatalf("got %d %s", rec.Code, rec.Body)
		}
	}
	if store.calls != 0 {
		t.Errorf("AddSDKDrops called %d times", store.calls)
	}
}

func TestHeartbeatSDKDropsFailOpen(t *testing.T) {
	store := &memSDKDrops{err: errors.New("valkey down")}
	body := `{"app_id":"storefront","instance_id":"i","dropped":{"logs":{"queue_bytes":1}}}`
	if rec := post(t, newDropsEdge(t, store, nil), "/v1/heartbeat", body, nil); rec.Code != http.StatusOK || store.calls != 1 {
		t.Fatalf("got %d %s, calls %d", rec.Code, rec.Body, store.calls)
	}
	// A plain StatsStore keeps no SDK drops; the heartbeat still answers 200.
	if rec := post(t, newDropsEdge(t, &memStats{}, nil), "/v1/heartbeat", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("plain stats: %d %s", rec.Code, rec.Body)
	}
}

// Drops are counted only on the 200 that tells the SDK to reset them: on
// 503 the SDK sends them again with its next heartbeat.
func TestHeartbeatSDKDropsNotCountedWithoutOK(t *testing.T) {
	store := &memSDKDrops{}
	body := `{"app_id":"storefront","instance_id":"i","dropped":{"requests":{"queue_full":3}}}`
	rec := post(t, newDropsEdge(t, store, &fakeCapture{err: errors.New("pg down")}), "/v1/heartbeat", body, nil)
	if rec.Code != http.StatusServiceUnavailable || store.calls != 0 {
		t.Fatalf("got %d, calls %d", rec.Code, store.calls)
	}
}

func TestHeartbeatRejectsBadSDKDrops(t *testing.T) {
	many := `{`
	for i := range maxSDKDropReasons + 1 {
		if i > 0 {
			many += ","
		}
		many += `"r` + string(rune('a'+i%26)) + string(rune('a'+i/26)) + `":1`
	}
	many += `}`
	cases := map[string]string{
		"negative":     `{"requests":{"queue_full":-1}}`,
		"not integer":  `{"requests":{"queue_full":1.5}}`,
		"not a map":    `{"requests":3}`,
		"bad reason":   `{"spans":{"Queue Full":1}}`,
		"empty reason": `{"spans":{"":1}}`,
		"many reasons": `{"logs":` + many + `}`,
	}
	for name, dropped := range cases {
		t.Run(name, func(t *testing.T) {
			store := &memSDKDrops{}
			rec := post(t, newDropsEdge(t, store, nil), "/v1/heartbeat", `{"app_id":"storefront","instance_id":"i","dropped":`+dropped+`}`, nil)
			if rec.Code != http.StatusUnprocessableEntity || store.calls != 0 {
				t.Fatalf("got %d %s, calls %d", rec.Code, rec.Body, store.calls)
			}
		})
	}
}

func TestSortSDKDrops(t *testing.T) {
	got := SortSDKDrops(map[SDKDropKey]int64{{"spans", "b"}: 2, {"requests", "z"}: 5, {"logs", "a"}: 2, {"logs", "0"}: 2})
	want := []SDKDrop{{SDKDropKey{"requests", "z"}, 5}, {SDKDropKey{"logs", "0"}, 2}, {SDKDropKey{"logs", "a"}, 2}, {SDKDropKey{"spans", "b"}, 2}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}
