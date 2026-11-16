//go:build integration

package ingest_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/testutil"
)

// TestIngestRegistersEnvironments runs the whole path against real
// Postgres: an environment the project does not have appears in the
// project's environment list (source sdk, last seen set) shortly after the
// first record names it, without waiting for the cache TTL, and further
// records within a minute do not write again.
func TestIngestRegistersEnvironments(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}

	q := db.New(pool)
	ttl := time.Minute
	reg := prometheus.NewRegistry()
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 10, TTL: ttl, NegativeTTL: ttl}, logger, nil)
	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	ingest.New(verifier, catalog.NewAppResolver(q, ttl), discardSink{}, cfg, logger, nil).
		WithEnvironments(catalog.NewEnvironmentRegistry(q, projects.NewEnvironmentProvisioner(pool, audit.New(pool)), ttl, logger, reg)).
		Register(srv.Mux())
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	send := func(env string) {
		t.Helper()
		body := `{"logs":[{"app_id":"storefront","environment":"` + env + `","timestamp":"` +
			time.Now().UTC().Format(time.RFC3339) + `","level":"info","message":"hi"}]}`
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ts.URL+"/v1/logs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", seed.APIKey)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("logs %s = %d", env, resp.StatusCode)
		}
	}
	svc := projects.New(pool)
	find := func(name string) *projects.Environment {
		envs, err := svc.ListEnvironments(ctx, seed.ProjectID)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range envs {
			if e.Name == name {
				return &e
			}
		}
		return nil
	}
	waitFor := func(name string) *projects.Environment {
		t.Helper()
		deadline := time.Now().Add(ttl)
		for time.Now().Before(deadline) {
			if e := find(name); e != nil {
				return e
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("environment %s not listed within %v", name, ttl)
		return nil
	}

	start := time.Now()
	for range 50 {
		send("staging")
	}
	e := waitFor("staging")
	if e.Source != projects.SourceSDK || e.LastSeenAt == nil || e.FirstSeenAt == nil || e.IsProduction {
		t.Fatalf("staging = %+v", e)
	}
	t.Logf("staging listed after %v", time.Since(start))
	// Data for the seeded environment moves its last seen forward.
	send("production")
	deadline := time.Now().Add(5 * time.Second)
	for p := find("production"); p == nil || p.LastSeenAt == nil; p = find("production") {
		if time.Now().After(deadline) {
			t.Fatalf("production last seen not set: %+v", p)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var added int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events
		WHERE event = 'environment.added' AND target_id = 'staging' AND metadata->>'by' = 'sdk'`).Scan(&added); err != nil {
		t.Fatal(err)
	}
	if added != 1 {
		t.Fatalf("environment.added events = %d", added)
	}
}

// TestRegisterEnvironmentLimits checks the project cap and the hourly rate
// limit against real Postgres.
func TestRegisterEnvironmentLimits(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	prov := projects.NewEnvironmentProvisioner(pool, nil)
	key := uuid.New()
	now := time.Now()

	// Rate: five new environments an hour, then refused; an existing one
	// is still touched.
	for i := range projects.MaxNewSDKEnvironmentsPerHour {
		if created, err := prov.Register(ctx, seed.ProjectID, key, fmt.Sprintf("sdk-%d", i), now); err != nil || !created {
			t.Fatalf("register %d: %v %v", i, created, err)
		}
	}
	var limit *projects.EnvironmentLimitError
	if _, err := prov.Register(ctx, seed.ProjectID, key, "sdk-late", now); !errors.As(err, &limit) || limit.Limit != projects.EnvLimitNewPerHour {
		t.Fatalf("sixth = %v", err)
	}
	if created, err := prov.Register(ctx, seed.ProjectID, key, "sdk-0", now); err != nil || created {
		t.Fatalf("existing = %v %v", created, err)
	}

	// Cap: fill the project from the dashboard path, then refused even
	// once the hour has passed.
	if _, err := pool.Exec(ctx, `UPDATE environments SET created_at = now() - interval '2 hours' WHERE project_id = $1`, seed.ProjectID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM environments WHERE project_id = $1`, seed.ProjectID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	for i := n; i < projects.MaxEnvironments; i++ {
		if _, err := pool.Exec(ctx, `INSERT INTO environments (id, project_id, name) VALUES ($1, $2, $3)`, uuid.New(), seed.ProjectID, fmt.Sprintf("dash-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := prov.Register(ctx, seed.ProjectID, key, "sdk-over", now); !errors.As(err, &limit) || limit.Limit != projects.EnvLimitMax {
		t.Fatalf("over cap = %v", err)
	}
}
