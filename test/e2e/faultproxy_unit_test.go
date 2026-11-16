package e2e

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func gzipped(t *testing.T, s string) []byte {
	t.Helper()
	var b bytes.Buffer
	zw := gzip.NewWriter(&b)
	zw.ModTime = time.Now() // as an SDK would: the bytes differ per attempt
	if _, err := zw.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// proxyResult is the status and headers of a request through the proxy.
type proxyResult struct {
	status int
	header http.Header
}

func proxyPost(t *testing.T, client *http.Client, base, path string, body []byte, gz bool) (proxyResult, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "http://"+base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if gz {
		req.Header.Set("Content-Encoding", "gzip")
	}
	resp, err := client.Do(req)
	if err != nil {
		return proxyResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return proxyResult{resp.StatusCode, resp.Header}, nil
}

func TestFaultProxyModes(t *testing.T) {
	var forwarded atomic.Int32
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded.Add(1)
		if r.URL.Path != "/v1/requests" {
			w.WriteHeader(http.StatusOK)
			return
		}
		zr, err := gzip.NewReader(r.Body)
		if err != nil || r.Header.Get("Content-Encoding") != "gzip" {
			t.Errorf("edge got a body that is not the SDK's gzip: %v", err)
		} else {
			b, _ := io.ReadAll(zr)
			if !strings.Contains(string(b), `"app_id":"example-fastapi"`) {
				t.Errorf("edge got body %q", b)
			}
		}
		w.Header().Set("X-Edge", "yes")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer edge.Close()

	p, err := newFaultProxy("127.0.0.1:0", edge.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = p.Close() }()
	addr := p.Addr()
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	batch := `{"requests":[{"app_id":"example-fastapi","path":"/orders/1"},{"app_id":"example-fastapi","path":"/orders/2"}]}`
	start := time.Now()

	// Pass-through: forwarded with the edge's answer.
	resp, err := proxyPost(t, client, addr, "/v1/requests", gzipped(t, batch), true)
	if err != nil || resp.status != http.StatusAccepted || resp.header.Get("X-Edge") != "yes" {
		t.Fatalf("pass-through: %v %+v", err, resp)
	}

	// 5xx: answered by the proxy, not forwarded.
	if err := p.set(faultServerError, 0); err != nil {
		t.Fatal(err)
	}
	if resp, err = proxyPost(t, client, addr, "/v1/requests", gzipped(t, batch), true); err != nil || resp.status != http.StatusServiceUnavailable {
		t.Fatalf("5xx: %v %+v", err, resp)
	}

	// 429 with Retry-After.
	if err := p.set(faultRateLimited, 2); err != nil {
		t.Fatal(err)
	}
	resp, err = proxyPost(t, client, addr, "/v1/requests", gzipped(t, batch), true)
	if err != nil || resp.status != http.StatusTooManyRequests || resp.header.Get("Retry-After") != "2" {
		t.Fatalf("429: %v %+v", err, resp)
	}

	// Paused: 403 project_paused, as the edge answers a paused project.
	if err := p.set(faultPaused, 0); err != nil {
		t.Fatal(err)
	}
	if resp, err = proxyPost(t, client, addr, "/v1/requests", gzipped(t, batch), true); err != nil || resp.status != http.StatusForbidden {
		t.Fatalf("paused: %v %+v", err, resp)
	}

	// Down: the connection is refused, then the same address serves again.
	if err := p.set(faultDown, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := proxyPost(t, client, addr, "/v1/requests", gzipped(t, batch), true); err == nil {
		t.Fatal("down: request succeeded, want a refused connection")
	}
	if err := p.set(faultNone, 0); err != nil {
		t.Fatal(err)
	}
	if p.Addr() != addr {
		t.Fatalf("after down the proxy moved from %s to %s", addr, p.Addr())
	}
	if resp, err = proxyPost(t, client, addr, "/v1/requests", gzipped(t, batch), true); err != nil || resp.status != http.StatusAccepted {
		t.Fatalf("after recovery: %v %+v", err, resp)
	}
	if _, err := proxyPost(t, client, addr, "/v1/heartbeat", []byte(`{"app_id":"example-fastapi"}`), false); err != nil {
		t.Fatal(err)
	}

	if n := forwarded.Load(); n != 3 {
		t.Fatalf("edge got %d requests, want 3 (two batches and the heartbeat)", n)
	}
	got := p.attemptsBetween(start, time.Now().Add(time.Second))
	if len(got) != 6 {
		t.Fatalf("recorded %d attempts, want 6: %+v", len(got), got)
	}
	wantStatus := []int{http.StatusAccepted, http.StatusServiceUnavailable, http.StatusTooManyRequests, http.StatusForbidden, http.StatusAccepted, http.StatusOK}
	for i, a := range got {
		if a.Status != wantStatus[i] {
			t.Errorf("attempt %d status %d, want %d", i, a.Status, wantStatus[i])
		}
	}
	first := got[0]
	if first.App != "example-fastapi" || first.Records != 2 || !first.isBatch() || !first.Forwarded || first.Mode != faultNone {
		t.Errorf("first attempt = %+v", first)
	}
	for _, a := range got[1:5] {
		if a.Body != first.Body {
			t.Errorf("re-gzipped retry of one batch hashed %s, want %s", a.Body, first.Body)
		}
	}
	if got[1].Forwarded || got[2].Forwarded || got[3].Forwarded || got[1].Mode != faultServerError || got[2].Mode != faultRateLimited || got[3].Mode != faultPaused {
		t.Errorf("fault attempts = %+v", got[1:4])
	}
	if hb := got[5]; hb.isBatch() || hb.App != "" {
		t.Errorf("heartbeat recorded as a batch: %+v", hb)
	}

	// The same batch accepted twice is a duplicate delivery.
	dups := duplicateDeliveries(got)
	if len(dups) != 1 || dups[first.Body] != 2 {
		t.Errorf("duplicateDeliveries = %v, want the batch twice", dups)
	}
}

func TestRetryGapsAfter429(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	at := func(s float64) time.Time { return t0.Add(time.Duration(s * float64(time.Second))) }
	attempts := []proxyAttempt{
		{At: at(0), Path: "/v1/requests", App: "a", Body: "b1", Status: http.StatusTooManyRequests},
		{At: at(0.5), Path: "/v1/traces", App: "a", Body: "s1", Status: http.StatusTooManyRequests},
		{At: at(1), Path: "/v1/requests", App: "other", Body: "b9", Status: http.StatusTooManyRequests},
		{At: at(2.1), Path: "/v1/requests", App: "a", Body: "b1", Status: http.StatusTooManyRequests},
		{At: at(3), Path: "/v1/heartbeat", Status: http.StatusTooManyRequests},
		{At: at(4.2), Path: "/v1/requests", App: "a", Body: "b1", Status: http.StatusAccepted, Forwarded: true},
		{At: at(4.3), Path: "/v1/requests", App: "a", Body: "b1", Status: http.StatusAccepted, Forwarded: true},
	}
	gaps := retryGapsAfter429(attempts, "a")
	want := []time.Duration{2100 * time.Millisecond, 2100 * time.Millisecond}
	if len(gaps) != len(want) {
		t.Fatalf("gaps = %v, want %v", gaps, want)
	}
	for i := range want {
		if d := gaps[i] - want[i]; d < -time.Millisecond || d > time.Millisecond {
			t.Errorf("gap %d = %v, want %v", i, gaps[i], want[i])
		}
	}
}

func TestRetriedAfter(t *testing.T) {
	attempts := []proxyAttempt{
		{Path: "/v1/requests", App: "a", Body: "b1", Status: http.StatusForbidden},
		{Path: "/v1/requests", App: "a", Body: "b2", Status: http.StatusServiceUnavailable},
		{Path: "/v1/requests", App: "a", Body: "b2", Status: http.StatusForbidden},
		{Path: "/v1/requests", App: "other", Body: "b3", Status: http.StatusForbidden},
		{Path: "/v1/requests", App: "other", Body: "b3", Status: http.StatusForbidden},
		{Path: "/v1/heartbeat", Status: http.StatusForbidden},
		{Path: "/v1/heartbeat", Status: http.StatusForbidden},
		{Path: "/v1/requests", App: "a", Body: "b4", Status: http.StatusAccepted, Forwarded: true},
	}
	if got := retriedAfter(attempts, "a", http.StatusForbidden); len(got) != 0 {
		t.Errorf("app a: %v, want no batch retried after a 403", got)
	}
	attempts = append(attempts, proxyAttempt{Path: "/v1/requests", App: "a", Body: "b1", Status: http.StatusForbidden})
	if got := retriedAfter(attempts, "a", http.StatusForbidden); len(got) != 1 || got["b1"] != 1 {
		t.Errorf("app a: %v, want b1 once", got)
	}
	if got := retriedAfter(attempts, "other", http.StatusForbidden); got["b3"] != 1 {
		t.Errorf("app other: %v, want b3 once", got)
	}
}

func TestDescribeBatch(t *testing.T) {
	hash, app, n := describeBatch([]byte(`{"spans":[{"app_id":"x"}],"logs":[{"app_id":"y"},{}]}`), "")
	if hash == "" || app != "x" || n != 3 {
		t.Errorf("describeBatch = %q %q %d", hash, app, n)
	}
	if _, app, n := describeBatch([]byte("not json"), "gzip"); app != "" || n != 0 {
		t.Errorf("undecodable body: app %q, %d records", app, n)
	}
}
