// Command loadgen sends v1-format request records to an APILens edge at a
// fixed rate and reports throughput and latency. It replaces the legacy
// mock-ecommerce traffic generator for load and soak tests.
//
//	go -C tools run ./loadgen -url http://localhost:8080 -key apl_live_... -app default -rate 5000 -duration 30s
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	base := flag.String("url", "http://localhost:8080", "edge base URL")
	key := flag.String("key", os.Getenv("APILENS_API_KEY"), "ingest API key")
	app := flag.String("app", "default", "app slug")
	rate := flag.Int("rate", 1000, "records per second")
	batch := flag.Int("batch", 200, "records per request (SDK default is 200)")
	workers := flag.Int("concurrency", 8, "concurrent senders")
	duration := flag.Duration("duration", 30*time.Second, "test duration")
	payload := flag.Int("payload", 512, "bytes of request/response payload per record")
	flag.Parse()
	if *key == "" {
		fmt.Fprintln(os.Stderr, "loadgen: -key (or APILENS_API_KEY) is required")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *duration)
	defer cancel()

	batchesPerSec := float64(*rate) / float64(*batch)
	tick := time.NewTicker(time.Duration(float64(time.Second) / batchesPerSec))
	defer tick.Stop()
	jobs := make(chan struct{}, *workers*2)

	var (
		sent, ok, failed, dropped atomic.Int64
		mu                        sync.Mutex
		latencies                 []time.Duration
		status                    = map[int]int{}
	)
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: *workers}}
	body := filler(*payload)

	var wg sync.WaitGroup
	for range *workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobs {
				buf := makeBatch(*app, *batch, body)
				start := time.Now()
				code, err := send(client, *base, *key, buf)
				d := time.Since(start)
				mu.Lock()
				latencies = append(latencies, d)
				status[code]++
				mu.Unlock()
				sent.Add(int64(*batch))
				if err != nil || code != http.StatusOK {
					failed.Add(int64(*batch))
				} else {
					ok.Add(int64(*batch))
				}
			}
		}()
	}

	begin := time.Now()
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-tick.C:
			select {
			case jobs <- struct{}{}:
			default:
				dropped.Add(int64(*batch)) // senders saturated: the client, not the server, is the bottleneck
			}
		}
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(begin)

	slices.Sort(latencies)
	pct := func(p float64) time.Duration {
		if len(latencies) == 0 {
			return 0
		}
		return latencies[min(len(latencies)-1, int(p*float64(len(latencies))))]
	}
	fmt.Printf("duration        %s\n", elapsed.Round(time.Millisecond))
	fmt.Printf("records sent    %d (%.0f/s)\n", sent.Load(), float64(sent.Load())/elapsed.Seconds())
	fmt.Printf("records ok      %d\n", ok.Load())
	fmt.Printf("records failed  %d\n", failed.Load())
	fmt.Printf("client dropped  %d\n", dropped.Load())
	fmt.Printf("status codes    %v\n", status)
	fmt.Printf("batch latency   p50=%s p95=%s p99=%s max=%s\n", pct(0.50), pct(0.95), pct(0.99), pct(1))
	if failed.Load() > 0 {
		os.Exit(1)
	}
}

func filler(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a' + byte(i%26)
	}
	return string(b)
}

var paths = []string{"/orders/{id}", "/orders", "/products/{id}", "/cart", "/checkout", "/users/{id}"}

func makeBatch(app string, n int, payload string) []byte {
	type rec struct {
		AppID           string  `json:"app_id"`
		Timestamp       string  `json:"timestamp"`
		Environment     string  `json:"environment"`
		Method          string  `json:"method"`
		Path            string  `json:"path"`
		StatusCode      int     `json:"status_code"`
		ResponseTimeMs  float64 `json:"response_time_ms"`
		ConsumerID      string  `json:"consumer_id"`
		RequestPayload  string  `json:"request_payload"`
		ResponsePayload string  `json:"response_payload"`
	}
	recs := make([]rec, n)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for i := range recs {
		code := 200
		switch r := rand.IntN(100); {
		case r < 2:
			code = 500
		case r < 8:
			code = 404
		}
		recs[i] = rec{
			AppID: app, Timestamp: now, Environment: "load", Method: "GET", Path: paths[rand.IntN(len(paths))],
			StatusCode: code, ResponseTimeMs: rand.ExpFloat64() * 40, ConsumerID: fmt.Sprintf("user-%d", rand.IntN(500)),
			RequestPayload: payload, ResponsePayload: payload,
		}
	}
	b, _ := json.Marshal(map[string]any{"requests": recs})
	return b
}

func send(client *http.Client, base, key string, body []byte) (int, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, base+"/v1/requests", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", key)
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}
