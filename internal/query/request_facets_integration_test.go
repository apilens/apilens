//go:build integration

package query_test

import (
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/pipeline"
)

type requestFacets struct {
	Field  string `json:"field"`
	Values []struct {
		Value string `json:"value"`
		Label string `json:"label"`
		Count uint64 `json:"count"`
	} `json:"values"`
}

// pairs is "value=count" per facet value, in order.
func (f requestFacets) pairs() []string {
	out := []string{}
	for _, v := range f.Values {
		out = append(out, v.Value+"="+strconv.FormatUint(v.Count, 10))
	}
	return out
}

// TestRequestFacets checks GET /api/v1/requests/facets (#1052): counts per
// value under the other filters, the field's own conditions left out,
// search, and no rows of another project.
func TestRequestFacets(t *testing.T) {
	ctx, conn, mine, theirs, get := endpointRequestsEnv(t)
	now := time.Now().UTC()
	type fx struct {
		env, method, path string
		code              uint16
		consumer, name    string
		group             string
	}
	fixture := []fx{
		{"production", "GET", "/orders/{id}", 200, "c1", "Alice", "pro"},
		{"production", "GET", "/orders/{id}", 200, "c1", "Alice", "pro"},
		{"production", "GET", "/orders/{id}", 404, "c2", "Bob", ""},
		{"production", "POST", "/orders", 500, "c2", "Bob", ""},
		{"staging", "POST", "/orders", 201, "", "", ""},
		{"staging", "PUT", "/payments/{id}", 503, "c3", "Carol", "free"},
	}
	var rows []pipeline.RequestRow
	for i, f := range fixture {
		rows = append(rows, pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: f.env, Timestamp: now.Add(-time.Duration(i+1) * time.Minute),
			Method: f.method, Path: f.path, RawPath: f.path, StatusCode: f.code, ResponseTimeMs: 10,
			ConsumerID: f.consumer, ConsumerName: f.name, ConsumerGroup: f.group, Sampled: true,
		})
	}
	for _, r := range slices.Clone(rows) {
		r.ProjectID, r.AppID = theirs.ProjectID, theirs.AppID
		rows = append(rows, r)
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	f := func(c string) string { return "&filter=" + url.QueryEscape(c) }
	for _, c := range []struct {
		name, query string
		want        []string
	}{
		{"status", "field=status", []string{"200=2", "201=1", "404=1", "500=1", "503=1"}},
		{"method", "field=method", []string{"GET=3", "POST=2", "PUT=1"}},
		{"env", "field=env", []string{"production=4", "staging=2"}},
		{"app", "field=app", []string{mine.AppID.String() + "=6"}},
		{"path", "field=path", []string{"/orders/{id}=3", "/orders=2", "/payments/{id}=1"}},
		{"path search", "field=path&search=PAY", []string{"/payments/{id}=1"}},
		{"consumer leaves out none", "field=consumer", []string{"c1=2", "c2=2", "c3=1"}},
		{"consumer search by name", "field=consumer&search=car", []string{"c3=1"}},
		{"consumer_group", "field=consumer_group", []string{"pro=2", "free=1"}},
		// The field's own conditions are left out; the others apply.
		{"own field left out", "field=method" + f("method:eq:GET") + f("env:eq:production"), []string{"GET=3", "POST=1"}},
		{"other filter applies", "field=status" + f("method:neq:GET"), []string{"201=1", "500=1", "503=1"}},
		{"env param ignored for env", "field=env&env=staging", []string{"production=4", "staging=2"}},
		{"env param narrows others", "field=method&env=staging", []string{"POST=1", "PUT=1"}},
		{"limit", "field=status&limit=2", []string{"200=2", "201=1"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			var out requestFacets
			if code := get(mine.ReadKey, "/api/v1/requests/facets?range=1h&"+c.query, &out); code != http.StatusOK {
				t.Fatalf("status %d", code)
			}
			if got := out.pairs(); !slices.Equal(got, c.want) {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}

	// A consumer's name comes with its id.
	var consumers requestFacets
	if code := get(mine.ReadKey, "/api/v1/requests/facets?range=1h&field=consumer&search=c1", &consumers); code != http.StatusOK || len(consumers.Values) != 1 || consumers.Values[0].Label != "Alice" {
		t.Fatalf("consumer label: %d %+v", code, consumers)
	}

	for _, bad := range []string{"", "field=ip", "field=status&limit=51", "field=status" + f("bogus")} {
		if code := get(mine.ReadKey, "/api/v1/requests/facets?range=1h&"+bad, nil); code != http.StatusUnprocessableEntity {
			t.Errorf("%q: status %d, want 422", bad, code)
		}
	}
}
