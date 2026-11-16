//go:build integration

package query_test

import (
	"net/http"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/pipeline"
)

// TestAppScope checks the app filter of the request-level reads (#974): two
// apps of one project serve the same POST /orders. Without app every read
// counts both apps, as before; with app each read counts that app only; the
// endpoints list has one row per app for the shared path.
func TestAppScope(t *testing.T) {
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	billing := uuid.New() // a second app of mine; ClickHouse rows need no Postgres app
	now := time.Now().UTC()
	i := 0
	row := func(app uuid.UUID, code uint16, ms float64) pipeline.RequestRow {
		i++
		return pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: app, Environment: "production", Timestamp: now.Add(-time.Duration(i) * time.Minute),
			Method: "POST", Path: "/orders", RawPath: "/orders", StatusCode: code, ResponseTimeMs: ms, RequestSize: 10, ResponseSize: 20,
			ConsumerID: "alice", TraceID: uuid.NewString(),
		}
	}
	ins := pipeline.ClickHouseInserters(conn)
	if err := ins.Requests(ctx, []pipeline.RequestRow{
		row(mine.AppID, 200, 10), row(mine.AppID, 200, 20), row(mine.AppID, 500, 30),
		row(billing, 201, 40), row(billing, 404, 50),
	}); err != nil {
		t.Fatal(err)
	}
	exc := func(app uuid.UUID) pipeline.LogRow {
		return pipeline.LogRow{
			ProjectID: mine.ProjectID, AppID: app, Environment: "production", Timestamp: now.Add(-2 * time.Minute), Level: "ERROR",
			Message: "ValueError: bad order", LoggerName: "apilens.exception", EndpointMethod: "POST", EndpointPath: "/orders",
		}
	}
	if err := ins.Logs(ctx, []pipeline.LogRow{exc(mine.AppID), exc(billing), exc(billing)}); err != nil {
		t.Fatal(err)
	}

	fetch := func(path string, out any) {
		t.Helper()
		if code := get(mine.ReadKey, path, out); code != http.StatusOK {
			t.Fatalf("%s: status %d", path, code)
		}
	}
	app := func(id uuid.UUID) string { return "&app=" + id.String() }
	scopes := map[string]struct {
		q                        string
		requests, client, server uint64
		exceptions               uint64
	}{
		"all":     {"", 5, 1, 1, 3},
		"mine":    {app(mine.AppID), 3, 0, 1, 1},
		"billing": {app(billing), 2, 1, 0, 2},
		"theirs":  {app(theirs.AppID), 0, 0, 0, 0}, // an app of another project matches nothing
	}

	for name, sc := range scopes {
		// The request log, its timeline and the latency report.
		var log struct {
			Requests []struct {
				AppID string `json:"app_id"`
			} `json:"requests"`
		}
		fetch("/api/v1/requests?range=1h"+sc.q, &log)
		if uint64(len(log.Requests)) != sc.requests {
			t.Fatalf("%s: requests = %d, want %d", name, len(log.Requests), sc.requests)
		}
		var timeline struct {
			Buckets []struct {
				Requests     uint64 `json:"requests"`
				ClientErrors uint64 `json:"client_errors"`
			} `json:"buckets"`
		}
		fetch("/api/v1/requests/timeline?range=1h"+sc.q, &timeline)
		var n, c uint64
		for _, b := range timeline.Buckets {
			n, c = n+b.Requests, c+b.ClientErrors
		}
		if n != sc.requests || c != sc.client {
			t.Fatalf("%s: timeline = %d requests %d 4xx, want %d %d", name, n, c, sc.requests, sc.client)
		}
		var lat endpointLatency
		fetch("/api/v1/traffic/latency?range=1h"+sc.q, &lat)
		if lat.Summary.Requests != sc.requests {
			t.Fatalf("%s: traffic latency = %d requests, want %d", name, lat.Summary.Requests, sc.requests)
		}

		// Every endpoint detail tab, on the rollup and the raw path.
		for _, q := range []string{"range=1h" + sc.q, "range=1h&consumer=alice" + sc.q} {
			var reqs endpointRequests
			fetch(endpointTabURL("requests", "POST", "/orders", q), &reqs)
			if reqs.Summary.Requests != sc.requests || reqs.Summary.ClientErrors != sc.client || reqs.Summary.ServerErrors != sc.server {
				t.Fatalf("%s %s: endpoint requests = %+v", name, q, reqs.Summary)
			}
			var l endpointLatency
			fetch(endpointTabURL("latency", "POST", "/orders", q), &l)
			if l.Summary.Requests != sc.requests {
				t.Fatalf("%s %s: endpoint latency = %d requests", name, q, l.Summary.Requests)
			}
			var tr endpointTransfer
			fetch(endpointTabURL("transfer", "POST", "/orders", q), &tr)
			if tr.Summary.Requests != sc.requests || tr.Summary.RequestBytes != 10*sc.requests {
				t.Fatalf("%s %s: endpoint transfer = %+v", name, q, tr.Summary)
			}
		}
		var errs endpointErrors
		fetch(endpointTabURL("errors", "POST", "/orders", "range=1h"+sc.q), &errs)
		var exceptions uint64
		for _, e := range errs.Exceptions {
			exceptions += e.Count
		}
		if errs.Summary.Requests != sc.requests || errs.Summary.ClientErrors != sc.client || errs.Summary.ServerErrors != sc.server || exceptions != sc.exceptions {
			t.Fatalf("%s: endpoint errors = %+v, %d exceptions", name, errs.Summary, exceptions)
		}
	}

	// The endpoints list: one row per app for the shared path, and app keeps one.
	type endpointRow struct {
		AppID        string `json:"app_id"`
		Method       string `json:"method"`
		Path         string `json:"path"`
		Requests     uint64 `json:"requests"`
		ClientErrors uint64 `json:"client_errors"`
		ServerErrors uint64 `json:"server_errors"`
	}
	var list struct {
		Endpoints []endpointRow `json:"endpoints"`
	}
	fetch("/api/v1/traffic/endpoints?range=1h", &list)
	want := []endpointRow{
		{AppID: mine.AppID.String(), Method: "POST", Path: "/orders", Requests: 3, ServerErrors: 1},
		{AppID: billing.String(), Method: "POST", Path: "/orders", Requests: 2, ClientErrors: 1},
	}
	if !slices.Equal(list.Endpoints, want) {
		t.Fatalf("endpoints = %+v, want %+v", list.Endpoints, want)
	}
	var summary struct {
		Requests uint64 `json:"requests"`
	}
	fetch("/api/v1/traffic/summary?range=1h", &summary)
	var sum uint64
	for _, e := range list.Endpoints {
		sum += e.Requests
	}
	if sum != summary.Requests {
		t.Fatalf("endpoints add up to %d, summary has %d", sum, summary.Requests)
	}
	list.Endpoints = nil
	fetch("/api/v1/traffic/endpoints?range=1h"+app(billing), &list)
	if !slices.Equal(list.Endpoints, want[1:]) {
		t.Fatalf("endpoints app=billing = %+v", list.Endpoints)
	}

	for _, path := range []string{
		"/api/v1/requests?range=1h&app=storefront",
		"/api/v1/requests/timeline?range=1h&app=storefront",
		"/api/v1/traffic/endpoints?range=1h&app=storefront",
		"/api/v1/traffic/latency?range=1h&app=storefront",
		endpointTabURL("requests", "POST", "/orders", url.Values{"app": {"storefront"}}.Encode()),
		endpointTabURL("errors", "POST", "/orders", url.Values{"app": {"storefront"}}.Encode()),
	} {
		if code := get(mine.ReadKey, path, nil); code != http.StatusUnprocessableEntity {
			t.Fatalf("%s = %d, want 422", path, code)
		}
	}
}
