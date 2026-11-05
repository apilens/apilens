//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"
)

// Sizes of the sampling run, per example app.
const (
	samplingRequests     = 1000 // GET /orders/{id} at samplingRate
	samplingRate         = 0.1
	samplingHealthChecks = 100 // GET /health and /healthz, both excluded by default
	// The sampled-in count may sit this fraction of samplingRequests away
	// from samplingRate*samplingRequests: ±5% of 1000 is 50..150. The
	// binomial standard deviation is ~9.5, so a correct SDK stays well inside.
	samplingTolerance = 0.05
)

// TestExampleSampling proves the core guarantee of the sampling design
// through each SDK's example app (`task test:e2e:sampling` runs it):
//
//   - every request is counted, sampled in or out: /api/v1/traffic/summary
//     reports exactly 1000 requests per app at sample_rate 0.1;
//   - about a tenth keep their detail in the request log, the rest are base
//     records without headers or bodies;
//   - excluded paths never arrive: 100 health checks (/health and /healthz)
//     leave no row in any table and no count.
//
// The apps must run with APILENS_EXAMPLES_SAMPLE_RATE=0.1 and an environment
// no other traffic uses (APILENS_EXAMPLES_ENVIRONMENT), named here by
//
//	APILENS_E2E_SAMPLING_ENV=e2e-sampling-...
//
// Besides the APILENS_E2E_* variables of ingest_e2e_test.go (the read key is
// required) it reads APILENS_E2E_EXAMPLES and APILENS_E2E_EXAMPLE_APPS as
// privacy_e2e_test.go does.
func TestExampleSampling(t *testing.T) {
	envName := os.Getenv("APILENS_E2E_SAMPLING_ENV")
	if envName == "" {
		t.Skip("APILENS_E2E_SAMPLING_ENV not set; run `task test:e2e:sampling`")
	}
	e := loadEnv(t)
	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Fatal("APILENS_E2E_READ_KEY not set; the test reads /api/v1/traffic/summary")
	}
	bases := splitList(os.Getenv("APILENS_E2E_EXAMPLES"))
	if len(bases) == 0 {
		t.Fatal("APILENS_E2E_EXAMPLES not set; list the example app URLs (`task examples:up`)")
	}
	apps := splitList(envOr("APILENS_E2E_EXAMPLE_APPS", "example-fastapi,example-express,example-spring"))
	if len(apps) != len(bases) {
		t.Fatalf("APILENS_E2E_EXAMPLE_APPS has %d apps for %d APILENS_E2E_EXAMPLES URLs", len(apps), len(bases))
	}
	ids := e.appIDs(t, readKey)
	for _, app := range apps {
		if ids[app] == "" {
			t.Fatalf("app %s not in the read key's project; seed it with `task examples:up`", app)
		}
		// The environment must be fresh, so every count below is this run's.
		if n := e.summaryRequests(t, readKey, envName, ids[app]); n != 0 {
			t.Fatalf("%s: environment %q already has %d requests; use a fresh APILENS_E2E_SAMPLING_ENV", app, envName, n)
		}
	}

	// 1. The traffic: 1000 GET /orders/{id} and 100 health checks per app.
	client := &http.Client{Timeout: 15 * time.Second}
	for i, base := range bases {
		drive(t, client, apps[i], samplingRequests, func(n int) (string, int) {
			return base + "/orders/" + strconv.Itoa(n+1), http.StatusOK
		})
		drive(t, client, apps[i], samplingHealthChecks, func(n int) (string, int) {
			if n%2 == 0 {
				return base + "/health", http.StatusOK
			}
			return base + "/healthz", 0 // not routed by the apps: any status
		})
	}

	lo := int(float64(samplingRequests) * (samplingRate - samplingTolerance))
	hi := int(float64(samplingRequests) * (samplingRate + samplingTolerance))
	for _, app := range apps {
		id := ids[app]
		where := fmt.Sprintf("FROM api_requests WHERE app_id = '%s' AND environment = '%s'", id, envName)

		// 2. Every request is stored and counted, sampled in or out, and
		// nothing more: the health checks add no count.
		e.eventually(t, app+" request rows", "SELECT count() "+where, samplingRequests)
		if n := e.count(t, "SELECT count() "+where); n != samplingRequests {
			t.Errorf("%s: %d request rows, want %d", app, n, samplingRequests)
		}
		deadline := time.Now().Add(30 * time.Second)
		for {
			n := e.summaryRequests(t, readKey, envName, id)
			if n == samplingRequests {
				break
			}
			if n > samplingRequests || time.Now().After(deadline) {
				t.Errorf("%s: /api/v1/traffic/summary counts %d requests, want %d", app, n, samplingRequests)
				break
			}
			time.Sleep(500 * time.Millisecond)
		}

		// 3. About a tenth keep their detail; the others are base records.
		in := e.count(t, "SELECT count() "+where+" AND sampled = 1")
		t.Logf("%s: %d of %d requests sampled in at rate %.1f", app, in, samplingRequests, samplingRate)
		if in < lo || in > hi {
			t.Errorf("%s: %d of %d requests sampled in at rate %.1f, want %d..%d", app, in, samplingRequests, samplingRate, lo, hi)
		}
		if n := e.count(t, "SELECT count() "+where+" AND sampled = 1 AND request_headers = '' AND response_payload = ''"); n != 0 {
			t.Errorf("%s: %d sampled-in requests without any detail", app, n)
		}
		if n := e.count(t, "SELECT count() "+where+" AND sampled = 0 AND "+
			"(request_headers != '' OR response_headers != '' OR request_payload != '' OR response_payload != '')"); n != 0 {
			t.Errorf("%s: %d sampled-out requests still carry headers or bodies", app, n)
		}
		if in > 0 {
			e.checkDetail(t, readKey, envName, app, id, true)
		}
		if in < samplingRequests {
			e.checkDetail(t, readKey, envName, app, id, false)
		}
	}

	// 4. Excluded paths never arrive, in any table. Spans and logs may trail
	// the request rows, so look a few times before passing.
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, table := range []string{"api_requests", "api_spans", "api_logs"} {
			q := fmt.Sprintf("SELECT count() FROM %s WHERE environment = '%s' AND position(formatRowNoNewline('TabSeparated', *), '/health') > 0",
				table, envName)
			if n := e.count(t, q); n != 0 {
				t.Fatalf("excluded health checks arrived: %d %s rows in environment %s", n, table, envName)
			}
		}
		if time.Now().After(deadline) {
			return
		}
		time.Sleep(time.Second)
	}
}

// drive sends n GET requests for app from a few workers. target returns the
// i-th URL and the status it must answer with (0: any).
func drive(t *testing.T, client *http.Client, app string, n int, target func(i int) (string, int)) {
	t.Helper()
	const workers = 8
	jobs := make(chan int)
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				u, want := target(i)
				req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
				resp, err := client.Do(req)
				if err != nil {
					errs <- fmt.Errorf("GET %s: %w", u, err)
					continue
				}
				_, _ = io.Copy(io.Discard, resp.Body)
				_ = resp.Body.Close()
				if want != 0 && resp.StatusCode != want {
					errs <- fmt.Errorf("GET %s: status %d, want %d", u, resp.StatusCode, want)
				}
			}
		}()
	}
	for i := range n {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("%s: %v", app, err)
	}
}

// appIDs maps the app slugs of the read key's project to their ids.
func (e env) appIDs(t *testing.T, readKey string) map[string]string {
	t.Helper()
	var project struct {
		Apps []struct {
			ID   string `json:"id"`
			Slug string `json:"slug"`
		} `json:"apps"`
	}
	e.getJSON(t, readKey, "/api/v1/project", &project)
	ids := map[string]string{}
	for _, a := range project.Apps {
		ids[a.Slug] = a.ID
	}
	return ids
}

// summaryRequests is the requests total of /api/v1/traffic/summary for one
// app and environment over the last hour.
func (e env) summaryRequests(t *testing.T, readKey, envName, appID string) int {
	t.Helper()
	var s struct {
		Requests int `json:"requests"`
	}
	e.getJSON(t, readKey, "/api/v1/traffic/summary?"+url.Values{"range": {"1h"}, "env": {envName}, "app": {appID}}.Encode(), &s)
	return s.Requests
}

// checkDetail opens one sampled-in (or sampled-out) request of app from the
// request log: a sampled-in request shows its detail, a sampled-out one has
// no headers or bodies.
func (e env) checkDetail(t *testing.T, readKey, envName, app, appID string, sampled bool) {
	t.Helper()
	cursor := ""
	for {
		var list struct {
			Requests []struct {
				ID      string `json:"id"`
				AppID   string `json:"app_id"`
				Sampled bool   `json:"sampled"`
			} `json:"requests"`
			NextCursor string `json:"next_cursor"`
		}
		q := url.Values{"range": {"1h"}, "env": {envName}, "sampled": {strconv.FormatBool(sampled)}, "limit": {"200"}}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		e.getJSON(t, readKey, "/api/v1/requests?"+q.Encode(), &list)
		for _, r := range list.Requests {
			if r.AppID != appID {
				continue
			}
			var d struct {
				Request struct {
					Sampled         bool   `json:"sampled"`
					RequestHeaders  string `json:"request_headers"`
					ResponseHeaders string `json:"response_headers"`
					RequestBody     string `json:"request_body"`
					ResponseBody    string `json:"response_body"`
				} `json:"request"`
			}
			e.getJSON(t, readKey, "/api/v1/requests/"+url.PathEscape(r.ID), &d)
			got := d.Request
			switch {
			case r.Sampled != sampled || got.Sampled != sampled:
				t.Errorf("%s: request log filter sampled=%v gave row sampled=%v, detail sampled=%v", app, sampled, r.Sampled, got.Sampled)
			case sampled && got.RequestHeaders == "" && got.ResponseBody == "":
				t.Errorf("%s: sampled-in request detail has no headers or response body", app)
			case !sampled && (got.RequestHeaders != "" || got.ResponseHeaders != "" || got.RequestBody != "" || got.ResponseBody != ""):
				t.Errorf("%s: sampled-out request detail carries headers or bodies: %+v", app, got)
			}
			return
		}
		if cursor = list.NextCursor; cursor == "" {
			break
		}
	}
	t.Errorf("%s: no request with sampled=%v in the request log of environment %s", app, sampled, envName)
}
