//go:build e2e

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestQuotaEndToEnd drains the project's records-per-minute bucket with full
// batches and checks the edge answers 429 with Retry-After, stores nothing of
// the refused batch and counts it in ingest-stats. It runs only when the
// stack sets ingest.quota.records_per_minute (compose.ci.yaml does), read
// back from the project's ingest-status.
func TestQuotaEndToEnd(t *testing.T) {
	e := loadEnv(t)
	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Skip("APILENS_E2E_READ_KEY not set")
	}
	slug, appID := e.project(t, readKey)
	var status struct {
		Quota struct {
			RecordsPerMinute int64 `json:"records_per_minute"`
		} `json:"quota"`
	}
	e.getJSON(t, readKey, "/api/v1/projects/"+slug+"/ingest-status", &status)
	limit := status.Quota.RecordsPerMinute
	if limit == 0 {
		t.Skip("ingest.quota.records_per_minute not set on the stack")
	}

	run := fmt.Sprintf("e2equota%d", time.Now().UnixNano())
	const batch = 1000 // ingest.max_records_per_request default; the quota is at least that
	batchOf := func(n int) map[string]any {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		reqs := make([]map[string]any, n)
		for i := range reqs {
			reqs[i] = map[string]any{"app_id": e.app, "timestamp": now, "environment": "e2e", "method": "GET",
				"path": "/" + run, "status_code": 200, "response_time_ms": 1}
		}
		return map[string]any{"requests": reqs}
	}

	accepted, refused := 0, false
	for try := 0; try <= int(limit)/batch+2 && !refused; try++ {
		code, header, body := e.postResp(t, "/v1/requests", batchOf(batch))
		switch code {
		case http.StatusOK:
			accepted += batch
		case http.StatusTooManyRequests:
			refused = true
			if s, err := strconv.Atoi(header.Get("Retry-After")); err != nil || s < 1 || s > 60 {
				t.Errorf("Retry-After = %q, want 1..60 seconds", header.Get("Retry-After"))
			}
			if !strings.Contains(body, `"quota_exceeded"`) || !strings.Contains(body, "records_per_minute") {
				t.Errorf("429 body = %s", body)
			}
		default:
			t.Fatalf("/v1/requests = %d %s", code, body)
		}
	}
	if !refused {
		t.Fatalf("no 429 after %d records with records_per_minute=%d", accepted, limit)
	}

	// Only the admitted batches are stored.
	e.eventually(t, "admitted requests", fmt.Sprintf("SELECT count() FROM api_requests WHERE path = '/%s'", run), accepted)
	time.Sleep(time.Second) // the sink flushes every 100ms in CI; give a refused batch time to show up if it leaked
	if n := e.count(t, fmt.Sprintf("SELECT count() FROM api_requests WHERE path = '/%s'", run)); n != accepted {
		t.Fatalf("stored %d requests, want the %d admitted", n, accepted)
	}

	var stats struct {
		Totals struct {
			Rejected int64 `json:"rejected"`
		} `json:"totals"`
	}
	e.getJSON(t, readKey, "/api/v1/apps/"+appID+"/ingest-stats?days=1", &stats)
	if stats.Totals.Rejected < batch {
		t.Fatalf("ingest-stats rejected = %d, want >= %d", stats.Totals.Rejected, batch)
	}

	// Leave the bucket usable for whatever runs next: a small batch fits as
	// soon as a few records have refilled.
	deadline := time.Now().Add(30 * time.Second)
	for {
		code, _, body := e.postResp(t, "/v1/requests", batchOf(1))
		if code == http.StatusOK {
			return
		}
		if code != http.StatusTooManyRequests || time.Now().After(deadline) {
			t.Fatalf("bucket did not refill: %d %s", code, body)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// postResp posts body with the ingest key and returns status, headers and
// body.
func (e env) postResp(t *testing.T, path string, body any) (int, http.Header, string) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodPost, e.base+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", e.key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(out)
}
