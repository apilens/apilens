package ingest

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/config"
)

type memRejections struct {
	mu     sync.Mutex
	counts map[appRejectionKey]int64
}

func (m *memRejections) AddAppRejections(_ context.Context, _ uuid.UUID, _ time.Time, c map[appRejectionKey]int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.counts == nil {
		m.counts = map[appRejectionKey]int64{}
	}
	for k, n := range c {
		m.counts[k] += n
	}
	return nil
}

type memKeyApps struct {
	mu    sync.Mutex
	seen  []db.UpsertAPIKeyAppParams
	first []uuid.UUID
	done  chan struct{}
}

func (m *memKeyApps) UpsertAPIKeyApp(_ context.Context, p db.UpsertAPIKeyAppParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seen = append(m.seen, p)
	return nil
}

func (m *memKeyApps) MarkAppFirstSeen(_ context.Context, p db.MarkAppFirstSeenParams) error {
	m.mu.Lock()
	m.first = append(m.first, p.ID)
	m.mu.Unlock()
	m.done <- struct{}{}
	return nil
}

func TestPartialAppRejection(t *testing.T) {
	sink := &fakeSink{}
	rej := &memRejections{}
	keys := &memKeyApps{done: make(chan struct{}, 10)}
	reg := prometheus.NewRegistry()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), reg).
		WithAppRejections(rej).WithKeyApps(keys)
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)

	body := `{"requests":[
	 {"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/a","status_code":200},
	 {"app_id":"Ghost Service","timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/b","status_code":200},
	 {"app_id":"Ghost Service","timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/c","status_code":200},
	 {"timestamp":"2026-10-22T11:59:00Z","method":"GET","path":"/d","status_code":200}]}`
	rec := post(t, mux, "/v1/requests", body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	var got accepted
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Accepted != 2 || len(got.Rejected) != 1 || got.Rejected[0].Records != 2 || got.Rejected[0].Error != "app_create_forbidden" ||
		!strings.Contains(got.Rejected[0].Detail, "Ghost Service") {
		t.Fatalf("response %+v", got)
	}
	if len(sink.requests) != 2 || sink.requests[0].Path != "/a" || sink.requests[1].Path != "/d" || sink.requests[1].AppID != testApp {
		t.Fatalf("stored %+v", sink.requests)
	}
	if n := testutil.ToFloat64(e.appRejected.WithLabelValues("app_create_forbidden")); n != 2 {
		t.Fatalf("metric = %v", n)
	}
	if rej.counts[appRejectionKey{"app_create_forbidden", "Ghost Service"}] != 2 {
		t.Fatalf("rejection counters %v", rej.counts)
	}
	<-keys.done
	keys.mu.Lock()
	if len(keys.seen) != 1 || keys.seen[0].AppID != testApp {
		t.Fatalf("key usage %+v", keys.seen)
	}
	keys.mu.Unlock()

	// Within a minute the same key and app are not written again.
	if rec := post(t, mux, "/v1/requests", validRequest, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	select {
	case <-keys.done:
		t.Fatal("key usage written twice within a minute")
	case <-time.After(50 * time.Millisecond):
	}

	// Every record rejected: the call fails with the reason.
	all := strings.Replace(validRequest, `"storefront"`, `"ghost"`, 1)
	rec = post(t, mux, "/v1/requests", all, nil)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"error":"app_create_forbidden"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
}

func TestRejectionStatus(t *testing.T) {
	cases := map[string]int{
		"app_create_forbidden": 403, "app_not_allowed": 403, "app_deleted": 409,
		"app_limit": 422, "app_rate_limit": 422, "invalid_app_name": 422,
	}
	for reason, want := range cases {
		if got := rejectionStatus(reason); got != want {
			t.Errorf("%s: %d, want %d", reason, got, want)
		}
	}
}
