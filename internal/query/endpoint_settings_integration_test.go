//go:build integration

package query_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEndpointSettings saves settings through the API (project admins only,
// against a real SpiceDB) and checks that summary, timeseries, endpoints and
// errors leave out expected status codes and excluded endpoints, while the
// request log keeps them.
func TestEndpointSettings(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	admin, member := uuid.New(), uuid.New()
	for i, u := range []uuid.UUID{admin, member} {
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, u, []string{"admin@example.com", "member@example.com"}[i]); err != nil {
			t.Fatal(err)
		}
	}
	client := authz.New(sdb, nil, authz.Options{}, logger, nil)
	if _, err := client.WriteRelationships(ctx, seed.OrgID.String(), []*v1.RelationshipUpdate{
		touch("project", seed.ProjectID.String(), "org", "organization", seed.OrgID.String()),
		orgRoleDefault(seed.ProjectID.String(), "default_editor", seed.OrgID.String(), "member"),
		orgRoleDefault(seed.ProjectID.String(), "default_viewer", seed.OrgID.String(), "viewer"),
		touch("organization", seed.OrgID.String(), "admin", "user", admin.String()),
		touch("organization", seed.OrgID.String(), "member", "user", member.String()),
	}); err != nil {
		t.Fatal(err)
	}

	// /orders/{id}: 200, 404, 404, 500. /health: 200, 503 (to be excluded).
	ins := pipeline.ClickHouseInserters(conn)
	now := time.Now().UTC()
	var rows []pipeline.RequestRow
	add := func(path string, codes ...uint16) {
		for _, c := range codes {
			rows = append(rows, pipeline.RequestRow{
				ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production", Timestamp: now.Add(-time.Duration(len(rows)+1) * time.Minute),
				Method: "GET", Path: path, RawPath: path, StatusCode: c, ResponseTimeMs: 10,
			})
		}
	}
	add("/orders/{id}", 200, 404, 404, 500)
	add("/health", 200, 503)
	if err := ins.Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	api := srv.API()
	api.UseMiddleware(func(hctx huma.Context, next func(huma.Context)) {
		if id := hctx.Header("X-Test-User"); id != "" {
			hctx = huma.WithContext(hctx, authn.WithPrincipal(hctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: uuid.MustParse(id)}))
		}
		next(hctx)
	})
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	guard := authz.NewGuard(client, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	query.Register(api, query.NewService(conn, q), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	do := func(method, path, user string, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		if user != "" {
			req.Header.Set("X-Test-User", user)
		} else {
			req.Header.Set("Authorization", "Bearer "+seed.ReadKey)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	settingsPath := func(path string) string {
		return "/api/v1/apps/" + seed.AppID.String() + "/endpoints/GET/" + url.PathEscape(path) + "/settings"
	}

	type summary struct {
		Requests     uint64  `json:"requests"`
		ClientErrors uint64  `json:"client_errors"`
		ServerErrors uint64  `json:"server_errors"`
		ErrorRate    float64 `json:"error_rate"`
	}
	var before summary
	if code := do(http.MethodGet, "/api/v1/traffic/summary?range=1h", "", nil, &before); code != 200 ||
		before.Requests != 6 || before.ClientErrors != 2 || before.ServerErrors != 2 {
		t.Fatalf("summary before = %d %+v", code, before)
	}

	// Defaults, readable with the read key and by a session with ?project=.
	var got struct {
		ExpectedStatusCodes []int   `json:"expected_status_codes"`
		Excluded            bool    `json:"excluded"`
		UpdatedBy           *string `json:"updated_by"`
	}
	if code := do(http.MethodGet, settingsPath("/orders/{id}"), "", nil, &got); code != 200 || len(got.ExpectedStatusCodes) != 0 || got.Excluded {
		t.Fatalf("default settings = %d %+v", code, got)
	}
	if code := do(http.MethodGet, settingsPath("/orders/{id}")+"?project=shop", member.String(), nil, &got); code != 200 {
		t.Fatalf("member read = %d", code)
	}

	// Only project admins write.
	expect404 := map[string]any{"expected_status_codes": []int{404}, "excluded": false}
	if code := do(http.MethodPut, settingsPath("/orders/{id}"), member.String(), expect404, nil); code != http.StatusForbidden {
		t.Fatalf("member write = %d, want 403", code)
	}
	if code := do(http.MethodPut, settingsPath("/orders/{id}"), "", expect404, nil); code != http.StatusUnauthorized {
		t.Fatalf("read key write = %d, want 401", code)
	}
	if code := do(http.MethodPut, settingsPath("/orders/{id}"), uuid.NewString(), expect404, nil); code != http.StatusNotFound {
		t.Fatalf("stranger write = %d, want 404", code)
	}
	if code := do(http.MethodPut, settingsPath("/orders/{id}"), admin.String(), expect404, &got); code != 200 ||
		len(got.ExpectedStatusCodes) != 1 || got.UpdatedBy == nil || *got.UpdatedBy != admin.String() {
		t.Fatalf("admin write = %d %+v", code, got)
	}
	if code := do(http.MethodPut, settingsPath("/health"), admin.String(), map[string]any{"excluded": true, "latency_threshold_ms": 50}, nil); code != 200 {
		t.Fatalf("exclude = %d", code)
	}

	// Summary: /health gone, the two expected 404s are not errors.
	var after summary
	if code := do(http.MethodGet, "/api/v1/traffic/summary?range=1h", "", nil, &after); code != 200 ||
		after.Requests != 4 || after.ClientErrors != 0 || after.ServerErrors != 1 || after.ErrorRate != 0.25 {
		t.Fatalf("summary after = %d %+v", code, after)
	}

	var series struct {
		Points []summary `json:"points"`
	}
	if code := do(http.MethodGet, "/api/v1/traffic/timeseries?range=1h", "", nil, &series); code != 200 {
		t.Fatalf("timeseries = %d", code)
	}
	var tot summary
	for _, p := range series.Points {
		tot.Requests += p.Requests
		tot.ClientErrors += p.ClientErrors
		tot.ServerErrors += p.ServerErrors
	}
	if tot.Requests != 4 || tot.ClientErrors != 0 || tot.ServerErrors != 1 {
		t.Fatalf("timeseries totals = %+v", tot)
	}

	var endpoints struct {
		Endpoints []struct {
			Path string `json:"path"`
			summary
		} `json:"endpoints"`
	}
	if code := do(http.MethodGet, "/api/v1/traffic/endpoints?range=1h", "", nil, &endpoints); code != 200 || len(endpoints.Endpoints) != 1 {
		t.Fatalf("endpoints = %d %+v", code, endpoints)
	}
	if e := endpoints.Endpoints[0]; e.Path != "/orders/{id}" || e.ClientErrors != 0 || e.ServerErrors != 1 || e.ErrorRate != 0.25 {
		t.Fatalf("endpoint = %+v", e)
	}

	var errs struct {
		Errors []struct {
			Path       string `json:"path"`
			StatusCode int    `json:"status_code"`
		} `json:"errors"`
	}
	if code := do(http.MethodGet, "/api/v1/errors?range=1h", "", nil, &errs); code != 200 || len(errs.Errors) != 1 || errs.Errors[0].StatusCode != http.StatusInternalServerError {
		t.Fatalf("errors = %d %+v", code, errs)
	}

	// Explore keeps every request, excluded endpoints included.
	var reqs struct {
		Requests []struct{} `json:"requests"`
	}
	if code := do(http.MethodGet, "/api/v1/requests?range=1h", "", nil, &reqs); code != 200 || len(reqs.Requests) != 6 {
		t.Fatalf("requests = %d %d, want 6", code, len(reqs.Requests))
	}
}
