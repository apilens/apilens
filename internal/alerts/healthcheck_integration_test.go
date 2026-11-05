//go:build integration

package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

// TestHealthChecksPostgres runs the health checker over real Postgres and
// River against a local service: the service starts failing, the check
// goes down with a health_check event carrying the failed request (masked
// body) and a notify job, retried runs change nothing, and the first
// passing probe resolves it. A guarded checker never reaches the local
// service at all.
func TestHealthChecksPostgres(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[NotifyArgs]) error { return nil }))
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[DeliverArgs]) error { return nil }))
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(pool, config.JobsConfig{}, reg, time.Second, testutil.Logger(t), prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(pool)
	sealer := testSealer(t)
	chID := uuid.New()
	sealed, err := SealChannelConfig(sealer, chID, json.RawMessage(`{"addresses":["oncall@example.com"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: chID, ProjectID: seed.ProjectID, Type: string(ChannelEmail), Name: "on-call", ConfigEnc: sealed,
	}); err != nil {
		t.Fatal(err)
	}

	var failing, hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		if failing.Load() == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"down","token":"tok_live_123"}`))
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(srv.Close)

	check, err := q.CreateHealthCheck(ctx, db.CreateHealthCheckParams{
		ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production",
		Url: srv.URL + "/healthz", ExpectedStatus: 200, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if check.Status != "up" || check.CheckedAt != nil || check.LastResult != nil {
		t.Fatalf("new check = %+v", check)
	}
	if listed, err := q.ListHealthChecks(ctx, seed.ProjectID); err != nil || len(listed) != 1 || listed[0].ID != check.ID {
		t.Fatalf("list = %+v, %v", listed, err)
	}

	notifyJobs := func(event uuid.UUID) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'alerts.notify' AND args->>'event_id' = $1`, event.String()).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	events := func() []db.AlertEvent {
		t.Helper()
		evs, err := q.ListHealthCheckEvents(ctx, db.ListHealthCheckEventsParams{HealthCheckID: check.ID, Lim: 10})
		if err != nil {
			t.Fatal(err)
		}
		return evs
	}

	// Without private networks the checker refuses the local service.
	guarded := NewHealthChecker(pool, NewProber(ProberOptions{RetryDelay: time.Millisecond}), testutil.Logger(t), prometheus.NewRegistry())
	t0 := time.Now().UTC().Truncate(time.Minute).Add(-30 * time.Minute)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	if n, err := guarded.RunOnce(ctx, at(0)); err != nil || n != 1 {
		t.Fatalf("guarded run = %d, %v", n, err)
	}
	if hits.Load() != 0 {
		t.Fatalf("guarded checker reached the service %d times", hits.Load())
	}
	evs := events()
	if len(evs) != 1 || evs[0].State != "triggered" {
		t.Fatalf("guarded events = %+v", evs)
	}
	var blocked HealthCheckResult
	if err := json.Unmarshal(evs[0].Details, &blocked); err != nil || blocked.Error != "address not allowed (not a public address)" || blocked.Attempts != 1 {
		t.Errorf("guarded failure = %+v, %v", blocked, err)
	}
	// Start over for the real service.
	if _, err := pool.Exec(ctx, `DELETE FROM alert_events WHERE health_check_id = $1`, check.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE health_checks SET status = 'up', checked_at = NULL, last_result = NULL WHERE id = $1`, check.ID); err != nil {
		t.Fatal(err)
	}

	checker := NewHealthChecker(pool, NewProber(ProberOptions{AllowPrivateNetworks: true, RetryDelay: time.Millisecond}),
		testutil.Logger(t), prometheus.NewRegistry()).
		WithPrivacy(privacy.NewResolver(q, time.Minute)).WithNotifications(jc)

	// Passing: no event.
	if n, err := checker.RunOnce(ctx, at(1)); err != nil || n != 1 {
		t.Fatalf("run = %d, %v", n, err)
	}
	if len(events()) != 0 {
		t.Fatal("event while passing")
	}

	// Failing, retried: one event with the failed request.
	failing.Store(1)
	hits.Store(0)
	if _, err := checker.RunOnce(ctx, at(2)); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 {
		t.Errorf("attempts reaching the service = %d, want 2 (one retry)", hits.Load())
	}
	// A retried run (same time) and the next minute's failure change nothing.
	if _, err := checker.RunOnce(ctx, at(2)); err != nil {
		t.Fatal(err)
	}
	if _, err := checker.RunOnce(ctx, at(3)); err != nil {
		t.Fatal(err)
	}
	evs = events()
	if len(evs) != 1 {
		t.Fatalf("events = %d, want 1", len(evs))
	}
	ev := evs[0]
	var failure HealthCheckResult
	if err := json.Unmarshal(ev.Details, &failure); err != nil {
		t.Fatal(err)
	}
	if ev.Kind != "health_check" || ev.State != "triggered" || !ev.StartedAt.Equal(at(2)) || ev.RuleID != nil ||
		failure.StatusCode != 503 || failure.Attempts != 2 || failure.Error != "unexpected status 503" ||
		failure.BodySnippet != `{"status":"down","token":"[redacted]"}` {
		t.Errorf("event = %+v, failure = %+v", ev, failure)
	}
	if n := notifyJobs(ev.ID); n != 1 {
		t.Errorf("notify jobs = %d, want 1", n)
	}
	got, err := q.GetHealthCheck(ctx, db.GetHealthCheckParams{ProjectID: seed.ProjectID, ID: check.ID})
	if err != nil || got.Status != "down" || !got.StatusSince.Equal(at(2)) || got.CheckedAt == nil || !got.CheckedAt.Equal(at(3)) {
		t.Errorf("check = %+v, %v", got, err)
	}

	// The notifier sees the event: the project's channels and the details.
	notifier := NewNotifier(pool, jc, NotifierOptions{PublicUIURL: "https://app.example.com", Sealer: sealer}, testutil.Logger(t), nil)
	if n, err := notifier.FanOut(ctx, NotifyArgs{EventID: ev.ID, Notification: NotifyTriggered}); err != nil || n != 1 {
		t.Errorf("FanOut = %d, %v; want 1", n, err)
	}
	if sent, err := notifier.Deliver(ctx, DeliverArgs{EventID: ev.ID, ChannelID: chID, Notification: NotifyTriggered}); err != nil || !sent {
		t.Fatalf("Deliver = %v, %v", sent, err)
	}
	row, err := q.GetHealthCheckEventNotification(ctx, ev.ID)
	if err != nil || row.NotifiedAt == nil || row.AppName == "" || row.ProjectSlug != "shop" || len(row.ChannelIds) != 1 {
		t.Errorf("notification row = %+v, %v", row, err)
	}
	if _, err := q.GetAlertEventNotification(ctx, ev.ID); err == nil {
		t.Error("health check event returned as a rule's event")
	}
	if _, err := q.GetUptimeEventNotification(ctx, ev.ID); err == nil {
		t.Error("health check event returned as an uptime event")
	}

	// Passing again resolves it.
	failing.Store(0)
	if _, err := checker.RunOnce(ctx, at(4)); err != nil {
		t.Fatal(err)
	}
	evs = events()
	if len(evs) != 1 || evs[0].State != "resolved" || evs[0].EndedAt == nil || !evs[0].EndedAt.Equal(at(4)) {
		t.Fatalf("after recovery = %+v", evs)
	}
	if n := notifyJobs(ev.ID); n != 2 {
		t.Errorf("notify jobs = %d, want 2 (failing, passing)", n)
	}

	// A disabled check is not probed; an unchanged URL keeps the latest
	// result, a new one clears it.
	updated, err := q.UpdateHealthCheck(ctx, db.UpdateHealthCheckParams{
		ID: check.ID, ProjectID: seed.ProjectID, Environment: "production", Url: check.Url, ExpectedStatus: 200, Enabled: false,
	})
	if err != nil || updated.LastResult == nil || updated.CheckedAt == nil {
		t.Fatalf("disable = %+v, %v", updated, err)
	}
	moved, err := q.UpdateHealthCheck(ctx, db.UpdateHealthCheckParams{
		ID: check.ID, ProjectID: seed.ProjectID, Environment: "production", Url: check.Url + "?deep=1", ExpectedStatus: 200, Enabled: false,
	})
	if err != nil || moved.LastResult != nil || moved.CheckedAt != nil {
		t.Fatalf("new URL = %+v, %v", moved, err)
	}
	if n, err := checker.RunOnce(ctx, at(5)); err != nil || n != 0 {
		t.Errorf("disabled run = %d, %v", n, err)
	}

	// The schema keeps the kinds apart.
	if _, err := pool.Exec(ctx, `INSERT INTO alert_events (id, kind, value) VALUES ($1, 'health_check', 1)`, uuid.New()); err == nil {
		t.Error("health_check event without a check accepted")
	}
	if _, err := q.OpenHealthCheckEvent(ctx, db.OpenHealthCheckEventParams{ID: uuid.New(), HealthCheckID: check.ID, StartedAt: at(6)}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.OpenHealthCheckEvent(ctx, db.OpenHealthCheckEventParams{ID: uuid.New(), HealthCheckID: check.ID, StartedAt: at(7)}); err == nil {
		t.Error("second open event accepted")
	}

	// Deleting the check deletes its events.
	if n, err := q.DeleteHealthCheck(ctx, db.DeleteHealthCheckParams{ProjectID: seed.ProjectID, ID: check.ID}); err != nil || n != 1 {
		t.Fatalf("delete = %d, %v", n, err)
	}
	if len(events()) != 0 {
		t.Error("events outlived their check")
	}
}
