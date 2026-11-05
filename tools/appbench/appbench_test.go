package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOrderBodyIsValidJSONOfExactSize(t *testing.T) {
	for _, n := range []int{minBodyBytes, 1024, 32768} {
		b := orderBody(n)
		if len(b) != n {
			t.Fatalf("orderBody(%d) is %d bytes", n, len(b))
		}
		var v struct {
			Item       string `json:"item"`
			Quantity   int    `json:"quantity"`
			Email      string `json:"email"`
			CardNumber string `json:"card_number"`
		}
		if err := json.Unmarshal(b, &v); err != nil {
			t.Fatalf("orderBody(%d) is not JSON: %v", n, err)
		}
		if v.Item == "" || v.Quantity < 1 || !strings.HasSuffix(v.Email, "@example.com") || v.CardNumber == "" {
			t.Fatalf("orderBody(%d) would not pass /orders validation: %+v", n, v)
		}
	}
	if got := len(orderBody(1)); got != minBodyBytes {
		t.Fatalf("orderBody(1) = %d bytes, want the minimum %d", got, minBodyBytes)
	}
}

func TestParseSizes(t *testing.T) {
	got, err := parseSizes("32768, 1024,1024")
	if err != nil || len(got) != 2 || got[0] != 1024 || got[1] != 32768 {
		t.Fatalf("parseSizes = %v, %v", got, err)
	}
	if _, err := parseSizes("10"); err == nil {
		t.Fatal("a body too small for a valid order must be rejected")
	}
}

func TestPercentile(t *testing.T) {
	var s []time.Duration
	for i := 1; i <= 100; i++ {
		s = append(s, time.Duration(i)*time.Millisecond)
	}
	for p, want := range map[float64]time.Duration{0.5: 50 * time.Millisecond, 0.95: 95 * time.Millisecond, 0.99: 99 * time.Millisecond, 1: 100 * time.Millisecond} {
		if got := percentile(s, p); got != want {
			t.Errorf("p%v = %v, want %v", p*100, got, want)
		}
	}
	if percentile(nil, 0.5) != 0 {
		t.Error("percentile of no samples must be 0")
	}
}

func TestParseMemUsage(t *testing.T) {
	for in, want := range map[string]float64{"123.5MiB ": 123.5, "1.5GiB": 1536, "512KiB": 0.5, " 2MB": 2e6 / (1 << 20)} {
		got, err := parseMemUsage(in)
		if err != nil || got != want {
			t.Errorf("parseMemUsage(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := parseMemUsage("lots"); err == nil {
		t.Error("garbage must not parse")
	}
}

func TestMeasureCountsOnly201AsSamples(t *testing.T) {
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		var body bytes.Buffer
		_, _ = body.ReadFrom(r.Body)
		if body.Len() != 1024 {
			http.Error(w, "size", http.StatusBadRequest)
			return
		}
		if n.Add(1)%10 == 0 {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	row, err := measure(context.Background(), loadSpec{
		url: srv.URL + "/orders", body: orderBody(1024), concurrency: 2,
		warmup: 50 * time.Millisecond, duration: 300 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.Requests == 0 || row.Errors == 0 {
		t.Fatalf("want samples and errors, got %+v", row)
	}
	if row.P50Ms <= 0 || row.P95Ms < row.P50Ms || row.P99Ms < row.P95Ms || row.RPS <= 0 {
		t.Fatalf("inconsistent stats: %+v", row)
	}
}

func run(posture string, rows ...Row) RunResult {
	for i := range rows {
		rows[i].Posture = posture
	}
	return RunResult{Posture: posture, Concurrency: 4, Duration: "20s", Path: "/orders", Rows: rows}
}

func TestBuildReportAddedLatencyAndThresholds(t *testing.T) {
	runs := []RunResult{
		run("full",
			Row{App: "fastapi", BodyBytes: 1024, P50Ms: 3.5, P95Ms: 5, MemoryMiB: 200},
			Row{App: "fastapi", BodyBytes: 32768, P50Ms: 6, P95Ms: 12, MemoryMiB: 200}),
		run("off",
			Row{App: "fastapi", BodyBytes: 1024, P50Ms: 2, P95Ms: 4, MemoryMiB: 60},
			Row{App: "fastapi", BodyBytes: 32768, P50Ms: 3, P95Ms: 5, MemoryMiB: 60}),
		run("metadata",
			Row{App: "fastapi", BodyBytes: 1024, P50Ms: 2.25, P95Ms: 4.5, MemoryMiB: 70},
			Row{App: "fastapi", BodyBytes: 32768, P50Ms: 4.5, P95Ms: 6, MemoryMiB: 70, Errors: 2}),
	}
	rep, err := buildReport(runs, defaultThresholds())
	if err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, r := range rep.Rows {
		order = append(order, r.Posture+"/"+size(r.BodyBytes))
	}
	if got, want := strings.Join(order, ","), "off/1 KB,metadata/1 KB,full/1 KB,off/32 KB,metadata/32 KB,full/32 KB"; got != want {
		t.Fatalf("row order %s, want %s", got, want)
	}

	meta1k := rep.Rows[1]
	if *meta1k.AddedP50Ms != 0.25 || *meta1k.AddedP95Ms != 0.5 || *meta1k.AddedMemoryMiB != 10 || len(meta1k.Breaches) != 0 {
		t.Fatalf("metadata 1 KB: %+v", meta1k)
	}
	full1k := rep.Rows[2]
	if len(full1k.Breaches) != 2 { // added p50 1.5 ms > 1 ms, added memory 140 MiB > 128 MiB
		t.Fatalf("full 1 KB breaches = %v", full1k.Breaches)
	}
	full32k := rep.Rows[5]
	// Added p50 3 ms is only checked at the smallest body; added p95 7 ms > 5 ms is.
	if len(full32k.Breaches) != 2 || !strings.Contains(full32k.Breaches[0], "added p95") {
		t.Fatalf("full 32 KB breaches = %v", full32k.Breaches)
	}
	if b := rep.Rows[4].Breaches; len(b) != 1 || !strings.Contains(b[0], "2 non-201") {
		t.Fatalf("errors must breach: %v", b)
	}
	if rep.Rows[0].AddedP50Ms != nil || len(rep.Rows[0].Breaches) != 0 {
		t.Fatalf("baseline row must have no added values: %+v", rep.Rows[0])
	}

	md := rep.Markdown()
	for _, want := range []string{
		"| fastapi | 1 KB | off | 2.00 ms | 4.00 ms |",
		"| +0.25 ms | +0.50 ms |",
		"**over:** added p50 1.50 ms > 1.00 ms",
		"baseline",
		"Soft thresholds (annotated, not failing): added p50 ≤ 1.00 ms at the smallest body, added p95 ≤ 5.00 ms, added memory ≤ 128 MiB",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
	if got := len(rep.Breaches()); got != 5 {
		t.Errorf("Breaches() = %d, want 5", got)
	}
}

func TestBuildReportNeedsOneBaseline(t *testing.T) {
	if _, err := buildReport([]RunResult{run("full")}, defaultThresholds()); err == nil {
		t.Error("no off run must be an error")
	}
	a := Row{App: "spring", BodyBytes: 1024, P50Ms: 1}
	if _, err := buildReport([]RunResult{run("off", a), run("off", a)}, defaultThresholds()); err == nil {
		t.Error("two baselines for the same app and size must be an error")
	}
	// One run per app and posture (apps benchmarked separately) joins fine.
	b := Row{App: "express", BodyBytes: 1024, P50Ms: 1}
	rep, err := buildReport([]RunResult{run("off", a), run("off", b), run("full", Row{App: "express", BodyBytes: 1024, P50Ms: 1.5})}, defaultThresholds())
	if err != nil || len(rep.Rows) != 3 || *rep.Rows[2].AddedP50Ms != 0.5 {
		t.Fatalf("split runs: %v %+v", err, rep.Rows)
	}
}

func TestReportCmdAnnotatesAndOptionallyFails(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, r RunResult) string {
		p := filepath.Join(dir, name)
		b, _ := json.Marshal(r)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	off := write("off.json", run("off", Row{App: "express", BodyBytes: 1024, P50Ms: 1, P95Ms: 2}))
	full := write("full.json", run("full", Row{App: "express", BodyBytes: 1024, P50Ms: 4, P95Ms: 3}))
	md := filepath.Join(dir, "report.md")

	var out bytes.Buffer
	if err := reportCmd([]string{"-annotate", "-o", md, "-json", filepath.Join(dir, "r.json"), off, full}, &out); err != nil {
		t.Fatalf("soft thresholds must not fail by default: %v", err)
	}
	if !strings.Contains(out.String(), "::warning title=APILens SDK overhead::express full 1 KB: added p50 3.00 ms > 1.00 ms") {
		t.Fatalf("annotation missing: %q", out.String())
	}
	if b, err := os.ReadFile(md); err != nil || !strings.Contains(string(b), "| express | 1 KB | full |") {
		t.Fatalf("report.md: %v %s", err, b)
	}

	out.Reset()
	err := reportCmd([]string{"-annotate=false", "-fail-on-threshold", "-o", md, off, full}, &out)
	if !errors.Is(err, errThresholdBreached) {
		t.Fatalf("-fail-on-threshold: err = %v", err)
	}
}

func TestMeasureFixedRate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	row, err := measure(context.Background(), loadSpec{
		url: srv.URL, body: orderBody(1024), concurrency: 4, rate: 100, duration: 500 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 100 req/s for 0.5 s is 50 requests; allow for timer and scheduler slack.
	if row.Requests < 25 || row.Requests > 60 || row.Missed != 0 {
		t.Fatalf("fixed rate: %+v", row)
	}
}

func TestMeasureFixedRateCountsMissedTicks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	row, err := measure(context.Background(), loadSpec{
		url: srv.URL, body: orderBody(1024), concurrency: 1, rate: 200, duration: 400 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if row.Missed == 0 {
		t.Fatalf("a server slower than the rate must show missed ticks: %+v", row)
	}
	rep, err := buildReport([]RunResult{
		run("off", Row{App: "a", BodyBytes: 1024}),
		run("full", Row{App: "a", BodyBytes: 1024, Missed: row.Missed}),
	}, Thresholds{})
	if err != nil || len(rep.Rows[1].Breaches) != 1 || !strings.Contains(rep.Rows[1].Breaches[0], "not sent") {
		t.Fatalf("missed must breach: %v %+v", err, rep.Rows)
	}
}
