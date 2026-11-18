//go:build e2e

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Requests per /boom/* endpoint and app in the exceptions run.
const exceptionRequests = 3

// boomCase is one /boom/* endpoint of the example apps and what its
// apilens.exception log must hold.
type boomCase struct {
	path   string
	status int
	// contains are the texts the payload must hold: the raised exception's
	// message and, for a chain, the root cause's.
	contains []string
	// frames is the least number of recurse frames in the payload (0: none).
	frames int
	// minChain is the least exception.chain_depth (0: not checked). Python
	// and Java count the raised exception, Node counts the cause links, so a
	// 3-level chain is at least 2 everywhere.
	minChain int
}

const (
	outerMessage = "example failure: cannot load order 42"
	rootMessage  = "example failure: config key 'db_url' is missing"
)

var boomCases = []boomCase{
	{path: "/boom", status: http.StatusInternalServerError, contains: []string{"example failure: /boom always"}},
	{path: "/boom/chained", status: http.StatusInternalServerError, contains: []string{outerMessage, rootMessage}, minChain: 2},
	{path: "/boom/deep", status: http.StatusInternalServerError, contains: []string{"60 frames deep"}, frames: 60},
	{path: "/boom/handled", status: http.StatusInternalServerError, contains: []string{"example failure: handled by"}},
}

// exceptionLog is one api_logs row of the apilens.exception logger.
type exceptionLog struct {
	TraceID    string            `json:"trace_id"`
	Message    string            `json:"message"`
	Payload    string            `json:"payload"`
	Attributes map[string]string `json:"attributes"`
}

// TestExceptionsNeverLost proves the M5 guarantees (D1-D4) through each SDK's
// example app (`task test:e2e:exceptions` runs it). With sample_rate 0 on the
// apps, so healthy traffic keeps no detail:
//
//   - every request to /boom, /boom/chained, /boom/deep and /boom/handled is
//     kept (sampled) with a trace id, and has an apilens.exception log on its
//     trace whose payload holds the raised exception and, for the chain, the
//     root cause; the deep one carries all 60 recurse frames;
//   - the exception caught and logged by /boom/logged (a 200) is shipped too;
//   - GET /api/v1/traces/{trace_id} answers each of those payloads in full.
//
// The apps must run with APILENS_EXAMPLES_SAMPLE_RATE=0 in an environment no
// other traffic uses (APILENS_EXAMPLES_ENVIRONMENT), named here by
//
//	APILENS_E2E_EXCEPTIONS_ENV=e2e-exceptions-...
//
// Besides the APILENS_E2E_* variables of ingest_e2e_test.go (the read key is
// required) it reads APILENS_E2E_EXAMPLES and APILENS_E2E_EXAMPLE_APPS as
// sampling_e2e_test.go does.
func TestExceptionsNeverLost(t *testing.T) {
	envName := os.Getenv("APILENS_E2E_EXCEPTIONS_ENV")
	if envName == "" {
		t.Skip("APILENS_E2E_EXCEPTIONS_ENV not set; run `task test:e2e:exceptions`")
	}
	e := loadEnv(t)
	readKey := os.Getenv("APILENS_E2E_READ_KEY")
	if readKey == "" {
		t.Fatal("APILENS_E2E_READ_KEY not set; the test reads /api/v1/traces")
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
		if n := e.count(t, fmt.Sprintf("SELECT count() FROM api_requests WHERE app_id = '%s' AND environment = '%s'", ids[app], envName)); n != 0 {
			t.Fatalf("%s: environment %q already has %d requests; use a fresh APILENS_E2E_EXCEPTIONS_ENV", app, envName, n)
		}
	}

	// 1. The traffic: every /boom/* endpoint a few times per app.
	client := &http.Client{Timeout: 15 * time.Second}
	for i, base := range bases {
		for _, c := range boomCases {
			drive(t, client, apps[i], exceptionRequests, func(int) (string, int) { return base + c.path, c.status })
		}
		drive(t, client, apps[i], exceptionRequests, func(int) (string, int) { return base + "/boom/logged", http.StatusOK })
	}

	for _, app := range apps {
		id := ids[app]
		where := fmt.Sprintf("app_id = '%s' AND environment = '%s'", id, envName)
		failingTraces := map[string]bool{}

		// 2. Every failing request is kept with its trace and its full
		// exception, whatever the sample rate.
		for _, c := range boomCases {
			reqWhere := fmt.Sprintf("FROM api_requests WHERE %s AND path = '%s' AND status_code = %d", where, c.path, c.status)
			e.eventually(t, app+" "+c.path+" request rows", "SELECT count() "+reqWhere, exceptionRequests)
			var reqs []struct {
				TraceID string `json:"trace_id"`
				Sampled int    `json:"sampled"`
			}
			e.jsonRows(t, "SELECT trace_id, sampled "+reqWhere, &reqs)
			if len(reqs) != exceptionRequests {
				t.Errorf("%s %s: %d request rows, want %d", app, c.path, len(reqs), exceptionRequests)
			}
			for _, r := range reqs {
				if r.Sampled != 1 {
					t.Errorf("%s %s: a failing request was sampled out at sample rate 0 (errors are never sampled)", app, c.path)
				}
				if r.TraceID == "" {
					t.Errorf("%s %s: a failing request has no trace id", app, c.path)
					continue
				}
				failingTraces[r.TraceID] = true
				logs := e.awaitExceptionLogs(t, app+" "+c.path, fmt.Sprintf("%s AND trace_id = '%s'", where, r.TraceID), 1)
				log := pickException(logs, c.contains)
				checkException(t, app+" "+c.path, log, c)
				e.checkTracePayload(t, readKey, app+" "+c.path, log)
			}
		}

		// 3. The exception /boom/logged caught and logged (a 200, sampled
		// out) is shipped as well, with the whole chain, on the request's
		// trace when the request row carries one.
		chain := boomCase{contains: []string{outerMessage, rootMessage}, minChain: 2}
		loggedWhere := fmt.Sprintf("FROM api_requests WHERE %s AND path = '/boom/logged' AND status_code = 200", where)
		e.eventually(t, app+" /boom/logged request rows", "SELECT count() "+loggedWhere, exceptionRequests)
		var loggedReqs []struct {
			TraceID string `json:"trace_id"`
		}
		e.jsonRows(t, "SELECT trace_id "+loggedWhere, &loggedReqs)
		untraced := 0
		for _, r := range loggedReqs {
			if r.TraceID == "" {
				untraced++
				continue
			}
			logs := e.awaitExceptionLogs(t, app+" /boom/logged", fmt.Sprintf("%s AND trace_id = '%s'", where, r.TraceID), 1)
			log := pickException(logs, chain.contains)
			checkException(t, app+" /boom/logged", log, chain)
			e.checkTracePayload(t, readKey, app+" /boom/logged", log)
		}
		if untraced > 0 {
			// No trace on the request row to join on: the logged exceptions
			// are the chain logs on no failing trace.
			t.Logf("%s: %d /boom/logged request rows without a trace id; matching their logs by content", app, untraced)
			logs := e.awaitExceptionLogs(t, app+" /boom/logged", where, len(failingTraces)+untraced)
			found := 0
			for _, l := range logs {
				if !failingTraces[l.TraceID] && containsAll(l.Payload, chain.contains) {
					found++
				}
			}
			if found < untraced {
				t.Errorf("%s /boom/logged: %d logged exceptions with the whole chain shipped, want >= %d", app, found, untraced)
			}
		}
	}
}

// pickException is the first log whose payload holds every text of contains,
// or the first log when none does (checkException then reports it).
func pickException(logs []exceptionLog, contains []string) exceptionLog {
	for _, l := range logs {
		if containsAll(l.Payload, contains) {
			return l
		}
	}
	return logs[0]
}

func containsAll(s string, subs []string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}

// checkException checks one apilens.exception log against what its endpoint
// raised.
func checkException(t *testing.T, what string, l exceptionLog, c boomCase) {
	t.Helper()
	for _, s := range c.contains {
		if !strings.Contains(l.Payload, s) {
			t.Errorf("%s: exception payload lacks %q:\n%s", what, s, l.Payload)
		}
	}
	if c.frames > 0 {
		if n := countFrames(l.Payload, "recurse"); n < c.frames {
			t.Errorf("%s: exception payload has %d recurse frames, want >= %d:\n%s", what, n, c.frames, l.Payload)
		}
	}
	if l.Attributes["exception.type"] == "" || l.Attributes["exception.message"] == "" {
		t.Errorf("%s: exception log lacks exception.type or exception.message: %v", what, l.Attributes)
	}
	depth, err := strconv.Atoi(l.Attributes["exception.chain_depth"])
	if err != nil {
		t.Errorf("%s: exception.chain_depth = %q, want a number", what, l.Attributes["exception.chain_depth"])
	} else if depth < c.minChain {
		t.Errorf("%s: exception.chain_depth = %d, want >= %d", what, depth, c.minChain)
	}
}

// awaitExceptionLogs waits until at least want apilens.exception logs match
// where and returns them.
func (e env) awaitExceptionLogs(t *testing.T, what, where string, want int) []exceptionLog {
	t.Helper()
	q := "SELECT trace_id, message, payload, attributes FROM api_logs WHERE " + where +
		" AND logger_name = 'apilens.exception' ORDER BY timestamp"
	deadline := time.Now().Add(30 * time.Second)
	for {
		var logs []exceptionLog
		e.jsonRows(t, q, &logs)
		if len(logs) >= want {
			return logs
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: %d apilens.exception logs, want >= %d (query: %s)", what, len(logs), want, q)
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// checkTracePayload checks that GET /api/v1/traces/{trace_id} answers the
// exception log with its whole payload.
func (e env) checkTracePayload(t *testing.T, readKey, what string, l exceptionLog) {
	t.Helper()
	var tr struct {
		Logs []struct {
			LoggerName string `json:"logger_name"`
			Payload    string `json:"payload"`
		} `json:"logs"`
	}
	e.getJSON(t, readKey, "/api/v1/traces/"+url.PathEscape(l.TraceID), &tr)
	for _, got := range tr.Logs {
		if got.LoggerName == "apilens.exception" && got.Payload == l.Payload {
			return
		}
	}
	t.Errorf("%s: /api/v1/traces/%s has no apilens.exception log with the stored payload (%d logs)", what, l.TraceID, len(tr.Logs))
}

// jsonRows runs a ClickHouse query over the HTTP interface and decodes its
// JSONEachRow output into out (a pointer to a slice of structs).
func (e env) jsonRows(t *testing.T, query string, out any) {
	t.Helper()
	u := e.chURL + "/?database=apilens&query=" + url.QueryEscape(query+" FORMAT JSONEachRow")
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
	req.SetBasicAuth(e.chUser, e.chPass)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("clickhouse: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clickhouse %d: %s", resp.StatusCode, body)
	}
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	var b strings.Builder
	b.WriteByte('[')
	for _, line := range lines {
		if line == "" {
			continue
		}
		if b.Len() > 1 {
			b.WriteByte(',')
		}
		b.WriteString(line)
	}
	b.WriteByte(']')
	if err := json.Unmarshal([]byte(b.String()), out); err != nil {
		t.Fatalf("clickhouse rows %q: %v", body, err)
	}
}
