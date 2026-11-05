//go:build integration

package alerts

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

// TestNotifyPostgres runs the notification jobs over real Postgres and
// River: the event query, unique notify jobs, the per-channel fan-out and
// the email channel's email.send jobs with notified_at.
func TestNotifyPostgres(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	reg := jobs.NewRegistry()
	// Insert-only client: the jobs are checked in river_job, never worked.
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[NotifyArgs]) error { return nil }))
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[DeliverArgs]) error { return nil }))
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(pool, config.JobsConfig{}, reg, time.Second, testutil.Logger(t), prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	sealer := testSealer(t)
	q := db.New(pool)

	channel := func(typ ChannelType, cfg string) uuid.UUID {
		t.Helper()
		id := uuid.New()
		sealed, err := SealChannelConfig(sealer, id, json.RawMessage(cfg))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
			ID: id, ProjectID: seed.ProjectID, Type: string(typ), Name: string(typ) + " " + id.String(), ConfigEnc: sealed,
		}); err != nil {
			t.Fatal(err)
		}
		return id
	}
	mail := channel(ChannelEmail, `{"addresses":["oncall@example.com","ops@example.com"]}`)
	slack := channel(ChannelSlack, `{"webhook_url":"https://hooks.slack.com/services/T/B/X"}`)
	every := int32(60)
	rule, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
		ID: uuid.New(), ProjectID: seed.ProjectID, AppID: seed.AppID, Environment: "production",
		Name: "Checkout errors", Metric: string(MetricErrorRate), Condition: string(ConditionGT),
		Threshold: 0.05, WindowS: 300, EveryS: &every, Filters: []byte(`{}`),
		ChannelIds: []uuid.UUID{mail, slack}, Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ev, err := q.OpenAlertEvent(ctx, db.OpenAlertEventParams{ID: uuid.New(), RuleID: rule.ID, Value: 0.2, StartedAt: time.Now().UTC().Truncate(time.Second)})
	if err != nil {
		t.Fatal(err)
	}

	count := func(kind string) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind = $1`, kind).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// A retried evaluation inserts the notify job again: River keeps one.
	for range 2 {
		if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			_, err := jc.InsertTx(ctx, tx, NotifyArgs{EventID: ev.ID, Notification: NotifyTriggered}, nil)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	if n := count("alerts.notify"); n != 1 {
		t.Fatalf("notify jobs = %d, want 1", n)
	}

	n := NewNotifier(pool, jc, NotifierOptions{PublicUIURL: "https://app.example.com", Sealer: sealer}, testutil.Logger(t), nil)
	for range 2 {
		got, err := n.FanOut(ctx, NotifyArgs{EventID: ev.ID, Notification: NotifyTriggered})
		if err != nil || got != 2 {
			t.Fatalf("FanOut = %d, %v; want 2", got, err)
		}
	}
	if c := count("alerts.deliver"); c != 2 {
		t.Fatalf("deliver jobs = %d, want 2 (unique per channel)", c)
	}

	sent, err := n.Deliver(ctx, DeliverArgs{EventID: ev.ID, ChannelID: mail, Notification: NotifyTriggered})
	if err != nil || !sent {
		t.Fatalf("Deliver = %v, %v", sent, err)
	}
	if c := count("email.send"); c != 2 {
		t.Fatalf("email jobs = %d, want 2", c)
	}
	row, err := q.GetAlertEventNotification(ctx, ev.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.NotifiedAt == nil || row.ProjectSlug != "shop" || row.AppName == "" || row.RuleName != "Checkout errors" {
		t.Errorf("row = %+v", row)
	}

	// Deleting the channel drops it from the rule: nothing more is sent.
	if err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		tq := db.New(tx)
		if _, err := tq.DeleteNotificationChannel(ctx, db.DeleteNotificationChannelParams{ProjectID: seed.ProjectID, ID: mail}); err != nil {
			return err
		}
		_, err := tq.RemoveChannelFromAlertRules(ctx, db.RemoveChannelFromAlertRulesParams{ProjectID: seed.ProjectID, ChannelID: mail})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if sent, err := n.Deliver(ctx, DeliverArgs{EventID: ev.ID, ChannelID: mail, Notification: NotifyResolved}); sent || err != nil {
		t.Errorf("deleted channel: %v, %v", sent, err)
	}
}
