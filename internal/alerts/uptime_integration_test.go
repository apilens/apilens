//go:build integration

package alerts

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

// TestUptimePostgres runs the uptime checker over real Postgres and River:
// heartbeats land in app_instances as ingest writes them, the SDK of one
// environment stops, the environment goes down within four minutes with an
// uptime event and a notify job, and comes back up. A muted environment
// records the same events with no notify job.
func TestUptimePostgres(t *testing.T) {
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

	heartbeat := func(env string, at time.Time) {
		t.Helper()
		if err := q.UpsertAppInstance(ctx, db.UpsertAppInstanceParams{
			AppID: seed.AppID, Environment: env, InstanceID: "i-" + env, ProjectID: seed.ProjectID,
			SdkName: "apilens-python", SdkVersion: "1.0.0", Stats: []byte(`{}`), SeenAt: at,
		}); err != nil {
			t.Fatal(err)
		}
	}
	notifyJobs := func(event uuid.UUID) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = 'alerts.notify' AND args->>'event_id' = $1`, event.String()).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	uptimeEvents := func(env string) []db.AlertEvent {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT id, rule_id, state, value, started_at, ended_at, notified_at, kind, monitor_app_id, monitor_environment
			FROM alert_events WHERE kind = 'uptime' AND monitor_environment = $1 ORDER BY started_at`, env)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []db.AlertEvent
		for rows.Next() {
			var e db.AlertEvent
			if err := rows.Scan(&e.ID, &e.RuleID, &e.State, &e.Value, &e.StartedAt, &e.EndedAt, &e.NotifiedAt, &e.Kind, &e.MonitorAppID, &e.MonitorEnvironment); err != nil {
				t.Fatal(err)
			}
			out = append(out, e)
		}
		return out
	}

	checker := NewUptimeChecker(pool, testutil.Logger(t), prometheus.NewRegistry()).WithNotifications(jc)
	if _, err := SetUptimeMuted(ctx, q, seed.ProjectID, seed.AppID, "staging", true); err != nil {
		t.Fatal(err)
	}

	// The SDKs heartbeat every minute until minute 3, then both stop. The
	// job runs a few seconds into every minute.
	t0 := time.Now().UTC().Truncate(time.Minute).Add(-30 * time.Minute)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	stopped := at(3).Add(20 * time.Second)
	var downAt time.Time
	for m := 0; m <= 10; m++ {
		if hb := at(m).Add(20 * time.Second); !hb.After(stopped) {
			heartbeat("production", hb)
			heartbeat("staging", hb)
		}
		now := at(m).Add(5 * time.Second)
		if _, err := checker.RunOnce(ctx, now); err != nil {
			t.Fatal(err)
		}
		// A retried run changes nothing.
		if _, err := checker.RunOnce(ctx, now); err != nil {
			t.Fatal(err)
		}
		if downAt.IsZero() && len(uptimeEvents("production")) > 0 {
			downAt = now
		}
	}
	prod := uptimeEvents("production")
	if len(prod) != 1 {
		t.Fatalf("production events = %d, want 1", len(prod))
	}
	if gap := downAt.Sub(stopped); gap <= 0 || gap > 4*time.Minute {
		t.Fatalf("down reported %s after the SDK stopped, want within 4m", gap)
	}
	ev := prod[0]
	if ev.State != "triggered" || !ev.StartedAt.Equal(stopped) || ev.RuleID != nil ||
		ev.MonitorAppID == nil || *ev.MonitorAppID != seed.AppID {
		t.Errorf("event = %+v", ev)
	}
	if n := notifyJobs(ev.ID); n != 1 {
		t.Errorf("notify jobs for production = %d, want 1", n)
	}
	m, err := q.GetUptimeMonitor(ctx, db.GetUptimeMonitorParams{AppID: seed.AppID, Environment: "production"})
	if err != nil || m.Status != "down" || !m.StatusSince.Equal(stopped) || m.Muted {
		t.Errorf("monitor = %+v, %v", m, err)
	}

	// Muted: the event is recorded, no notification is queued.
	staging := uptimeEvents("staging")
	if len(staging) != 1 || staging[0].State != "triggered" {
		t.Fatalf("staging events = %+v, want one open", staging)
	}
	if n := notifyJobs(staging[0].ID); n != 0 {
		t.Errorf("notify jobs for muted staging = %d, want 0", n)
	}

	// The notifier sees the event: its project's channels, and the mute.
	notifier := NewNotifier(pool, jc, NotifierOptions{PublicUIURL: "https://app.example.com", Sealer: sealer}, testutil.Logger(t), nil)
	if got, err := notifier.FanOut(ctx, NotifyArgs{EventID: ev.ID, Notification: NotifyTriggered}); err != nil || got != 1 {
		t.Errorf("FanOut production = %d, %v; want 1", got, err)
	}
	if got, err := notifier.FanOut(ctx, NotifyArgs{EventID: staging[0].ID, Notification: NotifyTriggered}); err != nil || got != 0 {
		t.Errorf("FanOut muted staging = %d, %v; want 0", got, err)
	}
	if sent, err := notifier.Deliver(ctx, DeliverArgs{EventID: ev.ID, ChannelID: chID, Notification: NotifyTriggered}); err != nil || !sent {
		t.Fatalf("Deliver = %v, %v", sent, err)
	}
	row, err := q.GetUptimeEventNotification(ctx, ev.ID)
	if err != nil || row.NotifiedAt == nil || row.AppName == "" || row.ProjectSlug != "shop" {
		t.Errorf("notification row = %+v, %v", row, err)
	}

	// Production reports again: the event resolves at that heartbeat.
	back := at(20).Add(20 * time.Second)
	heartbeat("production", back)
	if _, err := checker.RunOnce(ctx, at(21).Add(5*time.Second)); err != nil {
		t.Fatal(err)
	}
	prod = uptimeEvents("production")
	if len(prod) != 1 || prod[0].State != "resolved" || prod[0].EndedAt == nil || !prod[0].EndedAt.Equal(back) {
		t.Fatalf("production after recovery = %+v", prod)
	}
	if n := notifyJobs(ev.ID); n != 2 {
		t.Errorf("notify jobs for production = %d, want 2 (down, up)", n)
	}

	// Unmuting does not notify the past; a new gap would.
	if m, err := SetUptimeMuted(ctx, q, seed.ProjectID, seed.AppID, "staging", false); err != nil || m.Muted || m.Status != "down" {
		t.Errorf("unmute = %+v, %v", m, err)
	}
	if n := notifyJobs(staging[0].ID); n != 0 {
		t.Errorf("notify jobs for staging after unmute = %d, want 0", n)
	}

	// A threshold event's notification is unaffected by the uptime path.
	if _, err := q.GetAlertEventNotification(ctx, ev.ID); err == nil {
		t.Error("uptime event returned as a rule's event")
	}
}
