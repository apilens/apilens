//go:build integration

package ingest

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/testutil"
)

// TestQuotaLowLimitsInValkey runs the edge against a real Valkey with tiny
// limits: batches are admitted until the bucket is empty, then refused with
// 429 and a Retry-After matching the refill rate, and every replica shares
// the bucket.
func TestQuotaLowLimitsInValkey(t *testing.T) {
	ctx := context.Background()
	client, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)

	t.Run("records per minute over HTTP, shared by replicas", func(t *testing.T) {
		quota := NewValkeyQuota(client, config.QuotaConfig{RecordsPerMinute: 3})
		newReplica := func() (*Edge, http.Handler) {
			cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
			e := New(fakeVerifier{}, fakeApps{}, &fakeSink{}, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil).WithQuota(quota)
			e.now = func() time.Time { return fixedNow }
			mux := http.NewServeMux()
			e.Register(mux)
			return e, mux
		}
		// fakeVerifier always answers testProject; start from a clean bucket.
		if err := client.Do(ctx, client.B().Del().Key(quotaKeyPrefix+ReasonRecordsPerMinute+":"+testProject.String()).Build()).Error(); err != nil {
			t.Fatal(err)
		}
		_, a := newReplica()
		eb, b := newReplica()
		for i, h := range []http.Handler{a, b, a} {
			if rec := post(t, h, "/v1/requests", validRequest, nil); rec.Code != http.StatusOK {
				t.Fatalf("batch %d: got %d %s", i+1, rec.Code, rec.Body)
			}
		}
		rec := post(t, b, "/v1/requests", validRequest, nil)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("4th batch: got %d %s, want 429", rec.Code, rec.Body)
		}
		// One record refills every 20s (3/min).
		secs, err := strconv.Atoi(rec.Header().Get("Retry-After"))
		if err != nil || secs < 1 || secs > 20 {
			t.Fatalf("Retry-After = %q, want 1..20 seconds", rec.Header().Get("Retry-After"))
		}
		if got := promtest.ToFloat64(eb.rejected.WithLabelValues(ReasonRecordsPerMinute)); got != 1 {
			t.Fatalf("apilens_ingest_rejected_total{reason=records_per_minute} = %v, want 1", got)
		}
	})

	t.Run("bytes per day", func(t *testing.T) {
		q := NewValkeyQuota(client, config.QuotaConfig{BytesPerDay: 1000})
		project := uuid.New()
		if d, err := q.Admit(ctx, project, 1, 600); err != nil || !d.Allowed {
			t.Fatalf("first = %+v, %v", d, err)
		}
		d, err := q.Admit(ctx, project, 1, 600)
		if err != nil || d.Allowed || d.Reason != ReasonBytesPerDay {
			t.Fatalf("second = %+v, %v, want refused by bytes_per_day", d, err)
		}
		// 200 missing bytes at 1000/day take about 4.8h to refill.
		if d.RetryAfter < 4*time.Hour || d.RetryAfter > 5*time.Hour {
			t.Fatalf("RetryAfter = %v, want ~4.8h", d.RetryAfter)
		}
		if d, err := q.Admit(ctx, project, 1, 400); err != nil || !d.Allowed {
			t.Fatalf("a batch that fits = %+v, %v", d, err)
		}
	})

	t.Run("all or nothing across limits; projects are separate", func(t *testing.T) {
		q := NewValkeyQuota(client, config.QuotaConfig{RecordsPerMinute: 10, BytesPerDay: 1000})
		project := uuid.New()
		if d, err := q.Admit(ctx, project, 1, 900); err != nil || !d.Allowed {
			t.Fatalf("first = %+v, %v", d, err)
		}
		// Refused by bytes: the 5 records must not be charged.
		if d, err := q.Admit(ctx, project, 5, 200); err != nil || d.Allowed || d.Reason != ReasonBytesPerDay {
			t.Fatalf("over bytes = %+v, %v", d, err)
		}
		if d, err := q.Admit(ctx, project, 9, 10); err != nil || !d.Allowed {
			t.Fatalf("full record budget after a refused batch = %+v, %v", d, err)
		}
		d, err := q.Admit(ctx, project, 1, 1)
		if err != nil || d.Allowed || d.Reason != ReasonRecordsPerMinute {
			t.Fatalf("over records = %+v, %v", d, err)
		}
		if d, err := q.Admit(ctx, uuid.New(), 10, 10); err != nil || !d.Allowed {
			t.Fatalf("another project = %+v, %v", d, err)
		}
	})

	t.Run("a batch larger than the budget waits for a full refill", func(t *testing.T) {
		q := NewValkeyQuota(client, config.QuotaConfig{RecordsPerMinute: 10})
		project := uuid.New()
		if d, err := q.Admit(ctx, project, 1, 1); err != nil || !d.Allowed {
			t.Fatalf("first = %+v, %v", d, err)
		}
		d, err := q.Admit(ctx, project, 50, 1)
		if err != nil || d.Allowed || d.RetryAfter <= 0 || d.RetryAfter > 6*time.Second+time.Millisecond {
			t.Fatalf("oversized = %+v, %v, want refused with a finite wait", d, err)
		}
	})
}
