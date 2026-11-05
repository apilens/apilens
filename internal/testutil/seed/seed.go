//go:build integration

// Package seed writes dashboard fixtures for integration tests: two tenant
// projects in Postgres, SDK heartbeats and the edge's per-app ingest
// counters. It is a separate package from testutil because it imports
// packages (ingest, bootstrap) whose own integration tests import testutil.
package seed

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
)

// Tenants are two projects in different orgs, each with one app in
// "production" and an ingest and a read key. Tests read Mine and check
// nothing of Theirs leaks.
type Tenants struct {
	Mine   bootstrap.Result
	Theirs bootstrap.Result
}

// TwoTenants seeds acme/shop/storefront (Mine) and other/bank/ledger
// (Theirs).
func TwoTenants(t *testing.T, ctx context.Context, pool *pgxpool.Pool) Tenants {
	t.Helper()
	mine, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	return Tenants{Mine: mine, Theirs: theirs}
}

// Instance is one SDK process heartbeat. Empty Environment means
// "production"; a zero SeenAt means now.
type Instance struct {
	Environment string
	InstanceID  string
	SDKName     string
	SDKVersion  string
	Runtime     string
	Release     string
	Commit      string
	PID         *int64
	Stats       map[string]any
	SeenAt      time.Time
}

// Heartbeat records i as the latest heartbeat of an instance of app, the
// way POST /v1/heartbeat stores it.
func Heartbeat(t *testing.T, ctx context.Context, q *db.Queries, app bootstrap.Result, i Instance) {
	t.Helper()
	if i.Environment == "" {
		i.Environment = "production"
	}
	if i.SeenAt.IsZero() {
		i.SeenAt = time.Now().UTC()
	}
	stats := []byte(`{}`)
	if i.Stats != nil {
		var err error
		if stats, err = json.Marshal(i.Stats); err != nil {
			t.Fatal(err)
		}
	}
	if err := q.UpsertAppInstance(ctx, db.UpsertAppInstanceParams{
		AppID: app.AppID, Environment: i.Environment, InstanceID: i.InstanceID, ProjectID: app.ProjectID,
		SdkName: i.SDKName, SdkVersion: i.SDKVersion, Runtime: i.Runtime, Release: i.Release, Commit: i.Commit,
		Pid: i.PID, Stats: stats, SeenAt: i.SeenAt,
	}); err != nil {
		t.Fatal(err)
	}
}

// IngestCounts adds c to the edge's counters of appID on the UTC day of day.
func IngestCounts(t *testing.T, ctx context.Context, stats *ingest.ValkeyStats, appID uuid.UUID, day time.Time, c ingest.Counts) {
	t.Helper()
	if err := stats.Add(ctx, day, map[uuid.UUID]ingest.Counts{appID: c}); err != nil {
		t.Fatal(err)
	}
}
