//go:build integration

package ingest

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

// TestInstanceLifecycleInference drives the restart/OOM inference (ADR 0010
// D10) against real Postgres: each case stores the heartbeats of earlier
// instances, then one heartbeat of a new process, and checks how the earlier
// ones ended.
func TestInstanceLifecycleInference(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(pool)
	e := &Edge{heartbeats: q, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

	type beat struct {
		instance, env, pod, container string
		at                            time.Duration // after t0
		workingSet, limit, oomKill    float64       // 0: not sent
		final                         bool
	}
	store := func(t *testing.T, b beat) ResourceSample {
		t.Helper()
		m := map[string]float64{"process.cpu.pct_of_limit.avg": 10}
		if b.workingSet > 0 {
			m["container.memory.working_set.max"] = b.workingSet
		}
		if b.limit > 0 {
			m["container.memory.limit"] = b.limit
		}
		if b.oomKill > 0 {
			m["container.memory.oom_kill"] = b.oomKill
		}
		s := ResourceSample{WindowS: 60, ContainerID: b.container, Metrics: m}
		if err := q.UpsertAppInstance(ctx, db.UpsertAppInstanceParams{
			AppID: seed.AppID, Environment: b.env, InstanceID: b.instance, ProjectID: seed.ProjectID,
			Stats: []byte("{}"), SeenAt: t0.Add(b.at), ContainerID: b.container, PodUid: b.pod,
			PodName: "pod-" + b.pod, Resources: resourceSnapshot(s), Final: b.final,
		}); err != nil {
			t.Fatal(err)
		}
		return s
	}
	run := func(t *testing.T, b beat) {
		t.Helper()
		s := store(t, b)
		e.inferLifecycle(ctx, seed.ProjectID, seed.AppID, b.env, b.instance, t0.Add(b.at), Identity{PodUID: b.pod, PodName: "pod-" + b.pod}, s)
	}
	ended := func(t *testing.T, env, instance string) (string, bool) {
		t.Helper()
		var reason string
		var at *time.Time
		if err := pool.QueryRow(ctx, `SELECT ended_reason, ended_at FROM app_instances WHERE app_id = $1 AND environment = $2 AND instance_id = $3`,
			seed.AppID, env, instance).Scan(&reason, &at); err != nil {
			t.Fatal(err)
		}
		return reason, at != nil
	}
	events := func(t *testing.T, env string) map[string]string {
		t.Helper()
		rows, err := q.ListAppInstanceEvents(ctx, db.ListAppInstanceEventsParams{
			AppID: seed.AppID, Environment: env, Since: t0.Add(-time.Hour), Until: t0.Add(time.Hour), MaxRows: 100,
		})
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, r := range rows {
			out[r.InstanceID] = r.Kind
		}
		return out
	}

	t.Run("container restart in the same pod", func(t *testing.T) {
		env := "restart"
		run(t, beat{instance: "old", env: env, pod: "p1", container: "c1"})
		run(t, beat{instance: "new", env: env, pod: "p1", container: "c2", at: 30 * time.Second})
		if r, ok := ended(t, env, "old"); !ok || r != "restart" {
			t.Fatalf("old = %q ended=%v, want restart", r, ok)
		}
		if _, ok := ended(t, env, "new"); ok {
			t.Fatal("the new instance must stay open")
		}
		if ev := events(t, env); ev["old"] != "restart" {
			t.Fatalf("events = %v", ev)
		}
	})

	t.Run("container restart near the memory limit is a suspected OOM", func(t *testing.T) {
		env := "suspected"
		run(t, beat{instance: "old", env: env, pod: "p2", container: "c1", workingSet: 95, limit: 100})
		run(t, beat{instance: "new", env: env, pod: "p2", container: "c2", at: 40 * time.Second})
		if r, _ := ended(t, env, "old"); r != "suspected_oom" {
			t.Fatalf("old = %q, want suspected_oom", r)
		}
	})

	t.Run("worker killed by the OOM killer and respawned", func(t *testing.T) {
		env := "oom"
		run(t, beat{instance: "w1", env: env, container: "c1"})
		run(t, beat{instance: "w2", env: env, container: "c1", at: 5 * time.Second})
		// w2 sees the cgroup's OOM killer fire; w1 never reports again.
		run(t, beat{instance: "w2", env: env, container: "c1", at: 65 * time.Second, oomKill: 1})
		run(t, beat{instance: "w3", env: env, container: "c1", at: 70 * time.Second})
		if _, ok := ended(t, env, "w1"); ok {
			t.Fatal("w1 ended before it was silent for 150 s")
		}
		run(t, beat{instance: "w2", env: env, container: "c1", at: 3 * time.Minute})
		if r, ok := ended(t, env, "w1"); !ok || r != "oom" {
			t.Fatalf("w1 = %q ended=%v, want oom", r, ok)
		}
		ev := events(t, env)
		if ev["w1"] != "oom" || ev["w2"] != "oom_kill" {
			t.Fatalf("events = %v", ev)
		}
	})

	t.Run("live sibling workers never end each other", func(t *testing.T) {
		env := "siblings"
		for i := range 5 {
			at := time.Duration(i) * time.Minute
			run(t, beat{instance: "a", env: env, container: "c1", at: at})
			run(t, beat{instance: "b", env: env, container: "c1", at: at + 20*time.Second})
		}
		for _, w := range []string{"a", "b"} {
			if r, ok := ended(t, env, w); ok {
				t.Fatalf("%s ended (%q) while alive", w, r)
			}
		}
		if ev := events(t, env); len(ev) != 0 {
			t.Fatalf("events = %v", ev)
		}
	})

	t.Run("graceful end is kept and a returning instance reopens", func(t *testing.T) {
		env := "graceful"
		run(t, beat{instance: "old", env: env, pod: "p3", container: "c1", final: true})
		run(t, beat{instance: "new", env: env, pod: "p3", container: "c2", at: 10 * time.Second})
		if r, ok := ended(t, env, "old"); !ok || r != "graceful" {
			t.Fatalf("old = %q ended=%v, want graceful", r, ok)
		}
		if ev := events(t, env); len(ev) != 0 {
			t.Fatalf("a graceful end is not a restart event: %v", ev)
		}
		// An instance wrongly closed comes back with its next heartbeat.
		store(t, beat{instance: "old", env: env, pod: "p3", container: "c1", at: time.Minute})
		if _, ok := ended(t, env, "old"); ok {
			t.Fatal("a heartbeat must reopen the instance")
		}
	})

	t.Run("processes outside containers are never inferred", func(t *testing.T) {
		env := "vm"
		run(t, beat{instance: "x", env: env})
		run(t, beat{instance: "y", env: env, at: 10 * time.Minute})
		if _, ok := ended(t, env, "x"); ok {
			t.Fatal("a silent VM process is stale, not restarted")
		}
	})

	t.Run("event details name the replacement", func(t *testing.T) {
		rows, err := q.ListAppInstanceEvents(ctx, db.ListAppInstanceEventsParams{
			AppID: seed.AppID, Environment: "restart", Since: t0.Add(-time.Hour), Until: t0.Add(time.Hour), MaxRows: 10,
		})
		if err != nil || len(rows) != 1 {
			t.Fatalf("rows = %v, %v", rows, err)
		}
		var d map[string]any
		if err := json.Unmarshal(rows[0].Details, &d); err != nil || d["replaced_by"] != "new" {
			t.Fatalf("details = %s", rows[0].Details)
		}
	})
}
