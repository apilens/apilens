package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

var postures = []string{"off", "metadata", "redacted", "full"}

func validPosture(p string) bool { return slices.Contains(postures, p) }

func parseSizes(s string) ([]int, error) {
	var out []int
	for f := range strings.SplitSeq(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(f))
		if err != nil || n < minBodyBytes {
			return nil, fmt.Errorf("-sizes: %q is not a body size >= %d bytes", f, minBodyBytes)
		}
		out = append(out, n)
	}
	slices.Sort(out)
	return slices.Compact(out), nil
}

// orderBody returns a valid `POST /orders` JSON body (every example app
// accepts it with 201) of exactly n bytes. The email and card number are
// there so the `redacted` posture has fields to mask; `item` carries the
// padding (every app echoes it, so the response grows with the request).
const (
	bodyPrefix   = `{"item":"`
	bodySuffix   = `","quantity":1,"email":"bench@example.com","card_number":"4111111111111111"}`
	minBodyBytes = len(bodyPrefix) + 1 + len(bodySuffix)
)

func orderBody(n int) []byte {
	n = max(n, minBodyBytes)
	b := make([]byte, 0, n)
	b = append(b, bodyPrefix...)
	for i := range n - len(bodyPrefix) - len(bodySuffix) {
		b = append(b, 'a'+byte(i%26))
	}
	return append(b, bodySuffix...)
}

type loadSpec struct {
	url         string
	body        []byte
	concurrency int
	rate        float64 // requests per second across all workers; 0 = closed loop
	warmup      time.Duration
	duration    time.Duration
}

type driveResult struct {
	lat    []time.Duration // requests that answered 201
	errors int             // requests that did not
	missed int             // rate mode: ticks with every worker still busy
}

// measure drives spec.url with spec.concurrency workers, untimed for
// spec.warmup and then timed for spec.duration. With spec.rate > 0 the
// workers send at that fixed total rate (open loop), so every posture sees
// the same load; with 0 each worker sends back to back (closed loop, peak
// throughput). A request counts as an error unless it answers 201.
func measure(ctx context.Context, spec loadSpec) (Row, error) {
	if spec.concurrency < 1 {
		return Row{}, errors.New("concurrency must be >= 1")
	}
	if spec.rate < 0 {
		return Row{}, errors.New("rate must be >= 0")
	}
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{MaxIdleConnsPerHost: spec.concurrency, MaxConnsPerHost: spec.concurrency},
	}
	defer client.CloseIdleConnections()

	if spec.warmup > 0 {
		if _, err := drive(ctx, client, spec, spec.warmup); err != nil {
			return Row{}, err
		}
	}
	start := time.Now()
	res, err := drive(ctx, client, spec, spec.duration)
	if err != nil {
		return Row{}, err
	}
	elapsed := time.Since(start)
	if len(res.lat) == 0 {
		return Row{}, fmt.Errorf("no successful requests (%d errors)", res.errors)
	}
	slices.Sort(res.lat)
	return Row{
		Requests: len(res.lat),
		Errors:   res.errors,
		Missed:   res.missed,
		RPS:      float64(len(res.lat)) / elapsed.Seconds(),
		P50Ms:    toMs(percentile(res.lat, 0.50)),
		P95Ms:    toMs(percentile(res.lat, 0.95)),
		P99Ms:    toMs(percentile(res.lat, 0.99)),
	}, nil
}

// drive runs the load for d. It fails only when ctx is cancelled.
func drive(ctx context.Context, client *http.Client, spec loadSpec, d time.Duration) (driveResult, error) {
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	var (
		mu  sync.Mutex
		res driveResult
		wg  sync.WaitGroup
	)
	var tokens chan struct{}
	if spec.rate > 0 {
		tokens = make(chan struct{})
		interval := time.Duration(float64(time.Second) / spec.rate)
		wg.Go(func() {
			tick := time.NewTicker(max(interval, time.Microsecond))
			defer tick.Stop()
			start, issued := time.Now(), 0
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					// A Ticker drops ticks when this loop is descheduled; issue
					// what the schedule says is due so the rate holds anyway.
					due := int(time.Since(start).Seconds() * spec.rate)
					for ; issued < due; issued++ {
						select {
						case tokens <- struct{}{}:
						default:
							mu.Lock()
							res.missed++ // every worker busy: the app is not keeping up with the rate
							mu.Unlock()
						}
					}
				}
			}
		})
	}
	for range spec.concurrency {
		wg.Go(func() {
			local := make([]time.Duration, 0, 4096)
			bad := 0
			for ctx.Err() == nil {
				if tokens != nil {
					select {
					case <-ctx.Done():
						continue
					case <-tokens:
					}
				}
				t0 := time.Now()
				code, err := post(ctx, client, spec.url, spec.body)
				took := time.Since(t0)
				if ctx.Err() != nil {
					break // cut off by the deadline: neither a sample nor an error
				}
				if err != nil || code != http.StatusCreated {
					bad++
					continue
				}
				local = append(local, took)
			}
			mu.Lock()
			res.lat = append(res.lat, local...)
			res.errors += bad
			mu.Unlock()
		})
	}
	wg.Wait()
	if err := context.Cause(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return driveResult{}, err
	}
	return res, nil
}

func post(ctx context.Context, client *http.Client, url string, body []byte) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// percentile returns the nearest-rank percentile of sorted samples.
func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(p*float64(len(sorted)) + 0.5)
	return sorted[min(max(rank-1, 0), len(sorted)-1)]
}

func toMs(d time.Duration) float64 { return float64(d) / float64(time.Millisecond) }

// readMemory reads the app's memory after the load: the container's memory
// usage from `docker stats` (cgroup usage, what the 512m compose limit
// counts), or the process RSS from `ps` for an app run on the host.
func readMemory(ctx context.Context, container, pid string) (float64, string, error) {
	switch {
	case container != "":
		out, err := exec.CommandContext(ctx, "docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container).Output() //nolint:gosec // G204: argv, no shell; the operator names the container
		if err != nil {
			return 0, "", fmt.Errorf("docker stats %s: %w", container, err)
		}
		used, _, _ := strings.Cut(string(out), "/")
		mib, err := parseMemUsage(used)
		return mib, "docker", err
	case pid != "":
		out, err := exec.CommandContext(ctx, "ps", "-o", "rss=", "-p", pid).Output() //nolint:gosec // G204: argv, no shell; the operator names the pid
		if err != nil {
			return 0, "", fmt.Errorf("ps -p %s: %w", pid, err)
		}
		kib, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
		if err != nil {
			return 0, "", fmt.Errorf("ps -p %s: %q is not a number", pid, out)
		}
		return kib / 1024, "rss", nil
	}
	return 0, "", nil
}

var memRE = regexp.MustCompile(`^\s*([0-9.]+)\s*([kKMGT]?i?B)\s*$`)

// parseMemUsage parses a `docker stats` size such as "123.4MiB" into MiB.
func parseMemUsage(s string) (float64, error) {
	m := memRE.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("unrecognised memory usage %q", strings.TrimSpace(s))
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, err
	}
	scale := map[string]float64{
		"B": 1.0 / (1 << 20), "KiB": 1.0 / 1024, "MiB": 1, "GiB": 1024, "TiB": 1 << 20,
		"kB": 1e3 / (1 << 20), "KB": 1e3 / (1 << 20), "MB": 1e6 / (1 << 20), "GB": 1e9 / (1 << 20), "TB": 1e12 / (1 << 20),
	}[m[2]]
	if scale == 0 {
		return 0, fmt.Errorf("unrecognised unit in %q", s)
	}
	return v * scale, nil
}
