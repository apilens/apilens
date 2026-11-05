//go:build integration

package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestAlertQueries(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)

	user := uuid.New()
	org, project, other, app := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email) VALUES ($1, 'alerts@example.com')`, []any{user}},
		{`INSERT INTO organizations (id, slug, name) VALUES ($1, 'alerts-org', 'Alerts')`, []any{org}},
		{`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'alerts-shop', 'Shop')`, []any{project, org}},
		{`INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'alerts-other', 'Other')`, []any{other, org}},
		{`INSERT INTO apps (id, project_id, slug, name) VALUES ($1, $2, 'api', 'API')`, []any{app, project}},
	} {
		if _, err := pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatal(err)
		}
	}
	violates := func(t *testing.T, err error, code string) {
		t.Helper()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != code {
			t.Fatalf("err = %v, want SQLSTATE %s", err, code)
		}
	}

	// Channels.
	slack, err := q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: uuid.New(), ProjectID: project, Type: "slack", Name: "ops-slack", ConfigEnc: []byte{1, 2, 3}, CreatedBy: &user,
	})
	if err != nil || slack.Type != "slack" || slack.CreatedBy == nil || *slack.CreatedBy != user {
		t.Fatalf("create channel = %+v, %v", slack, err)
	}
	email, err := q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: uuid.New(), ProjectID: project, Type: "email", Name: "on-call", ConfigEnc: []byte{4},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: uuid.New(), ProjectID: project, Type: "sms", Name: "pager", ConfigEnc: []byte{1},
	})
	violates(t, err, "23514") // check_violation: unknown type
	_, err = q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: uuid.New(), ProjectID: project, Type: "webhook", Name: "ops-slack", ConfigEnc: []byte{1},
	})
	violates(t, err, "23505") // unique_violation: name taken in the project
	_, err = q.CreateNotificationChannel(ctx, db.CreateNotificationChannelParams{
		ID: uuid.New(), ProjectID: project, Type: "webhook", Name: "empty", ConfigEnc: []byte{},
	})
	violates(t, err, "23514") // check_violation: config_enc must be set

	chans, err := q.ListNotificationChannels(ctx, project)
	if err != nil || len(chans) != 2 || chans[0].Name != "on-call" || chans[1].Name != "ops-slack" {
		t.Fatalf("list channels = %+v, %v", chans, err)
	}
	if _, err := q.GetNotificationChannel(ctx, db.GetNotificationChannelParams{ProjectID: other, ID: slack.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("channel from another project = %v, want ErrNoRows", err)
	}
	byIDs, err := q.ListNotificationChannelsByIDs(ctx, db.ListNotificationChannelsByIDsParams{ProjectID: project, Ids: []uuid.UUID{slack.ID, uuid.New()}})
	if err != nil || len(byIDs) != 1 || byIDs[0].ID != slack.ID {
		t.Fatalf("channels by ids = %+v, %v", byIDs, err)
	}
	if byIDs, err := q.ListNotificationChannelsByIDs(ctx, db.ListNotificationChannelsByIDsParams{ProjectID: other, Ids: []uuid.UUID{slack.ID}}); err != nil || len(byIDs) != 0 {
		t.Fatalf("channels by ids of another project = %+v, %v; want none", byIDs, err)
	}
	upd, err := q.UpdateNotificationChannel(ctx, db.UpdateNotificationChannelParams{ProjectID: project, ID: slack.ID, Name: "alerts-slack", ConfigEnc: []byte{9}})
	if err != nil || upd.Name != "alerts-slack" || upd.ConfigEnc[0] != 9 || upd.Type != "slack" {
		t.Fatalf("update channel = %+v, %v", upd, err)
	}

	// Rules.
	every := int32(60)
	rule, err := q.CreateAlertRule(ctx, db.CreateAlertRuleParams{
		ID: uuid.New(), ProjectID: project, AppID: app, Environment: "production", Name: "High error rate",
		Metric: "error_rate", Condition: "gt", Threshold: 0.05, WindowS: 300, EveryS: &every,
		NotifyAfterS: 120, ResolveAfterS: 300, Filters: []byte(`{"endpoint":"GET /orders"}`),
		ChannelIds: []uuid.UUID{slack.ID, email.ID}, Enabled: true, CreatedBy: &user,
	})
	if err != nil || rule.EveryS == nil || *rule.EveryS != 60 || rule.Cron != nil || len(rule.ChannelIds) != 2 {
		t.Fatalf("create rule = %+v, %v", rule, err)
	}
	cron := "0 * * * *"
	base := db.CreateAlertRuleParams{
		ProjectID: project, AppID: app, Environment: "production", Name: "Hourly traffic",
		Metric: "traffic", Condition: "lt", Threshold: 10, WindowS: 3600, Filters: []byte(`{}`), ChannelIds: []uuid.UUID{},
	}
	both := base
	both.ID, both.EveryS, both.Cron = uuid.New(), &every, &cron
	_, err = q.CreateAlertRule(ctx, both)
	violates(t, err, "23514") // every_s and cron are exclusive
	neither := base
	neither.ID = uuid.New()
	_, err = q.CreateAlertRule(ctx, neither)
	violates(t, err, "23514") // one schedule is required
	badMetric := base
	badMetric.ID, badMetric.Cron, badMetric.Metric = uuid.New(), &cron, "p99"
	_, err = q.CreateAlertRule(ctx, badMetric)
	violates(t, err, "23514")
	badFilters := base
	badFilters.ID, badFilters.Cron, badFilters.Filters = uuid.New(), &cron, []byte(`[]`)
	_, err = q.CreateAlertRule(ctx, badFilters)
	violates(t, err, "23514")
	hourly := base
	hourly.ID, hourly.Cron, hourly.Enabled = uuid.New(), &cron, false
	if _, err := q.CreateAlertRule(ctx, hourly); err != nil {
		t.Fatal(err)
	}

	rules, err := q.ListAlertRules(ctx, project)
	if err != nil || len(rules) != 2 || rules[0].Name != "High error rate" {
		t.Fatalf("list rules = %+v, %v", rules, err)
	}
	enabled, err := q.ListEnabledAlertRules(ctx)
	if err != nil || len(enabled) != 1 || enabled[0].ID != rule.ID {
		t.Fatalf("enabled rules = %+v, %v", enabled, err)
	}
	if _, err := q.GetAlertRule(ctx, db.GetAlertRuleParams{ProjectID: other, ID: rule.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("rule from another project = %v, want ErrNoRows", err)
	}
	ur, err := q.UpdateAlertRule(ctx, db.UpdateAlertRuleParams{
		ProjectID: project, ID: rule.ID, Environment: "staging", Name: rule.Name, Description: "5xx spike",
		Metric: "p95", Condition: "gte", Threshold: 800, WindowS: 600, Cron: &cron,
		NotifyAfterS: 0, ResolveAfterS: 0, Filters: []byte(`{}`), ChannelIds: rule.ChannelIds, Enabled: true,
	})
	if err != nil || ur.Metric != "p95" || ur.EveryS != nil || ur.Cron == nil || ur.Environment != "staging" || ur.AppID != app {
		t.Fatalf("update rule = %+v, %v", ur, err)
	}

	// Deleting a channel forgets it in every rule.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	qtx := q.WithTx(tx)
	if n, err := qtx.RemoveChannelFromAlertRules(ctx, db.RemoveChannelFromAlertRulesParams{ProjectID: project, ChannelID: slack.ID}); err != nil || n != 1 {
		t.Fatalf("remove channel from rules = %d, %v; want 1", n, err)
	}
	if n, err := qtx.DeleteNotificationChannel(ctx, db.DeleteNotificationChannelParams{ProjectID: project, ID: slack.ID}); err != nil || n != 1 {
		t.Fatalf("delete channel = %d, %v", n, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := q.GetAlertRule(ctx, db.GetAlertRuleParams{ProjectID: project, ID: rule.ID})
	if err != nil || len(got.ChannelIds) != 1 || got.ChannelIds[0] != email.ID {
		t.Fatalf("rule channels after delete = %+v, %v", got.ChannelIds, err)
	}

	// Events.
	t0 := time.Now().Add(-time.Hour).Truncate(time.Microsecond)
	ev, err := q.OpenAlertEvent(ctx, db.OpenAlertEventParams{ID: uuid.New(), RuleID: rule.ID, Value: 0.12, StartedAt: t0})
	if err != nil || ev.State != "triggered" || ev.EndedAt != nil || ev.NotifiedAt != nil {
		t.Fatalf("open event = %+v, %v", ev, err)
	}
	_, err = q.OpenAlertEvent(ctx, db.OpenAlertEventParams{ID: uuid.New(), RuleID: rule.ID, Value: 0.2, StartedAt: t0})
	violates(t, err, "23505") // one open event per rule
	if open, err := q.GetOpenAlertEvent(ctx, rule.ID); err != nil || open.ID != ev.ID {
		t.Fatalf("open event = %+v, %v", open, err)
	}
	if n, err := q.MarkAlertEventNotified(ctx, db.MarkAlertEventNotifiedParams{ID: ev.ID, NotifiedAt: t0.Add(2 * time.Minute)}); err != nil || n != 1 {
		t.Fatalf("mark notified = %d, %v", n, err)
	}
	if n, err := q.MarkAlertEventNotified(ctx, db.MarkAlertEventNotifiedParams{ID: ev.ID, NotifiedAt: t0.Add(time.Hour)}); err != nil || n != 0 {
		t.Fatalf("second mark notified = %d, %v; want 0", n, err)
	}
	res, err := q.ResolveAlertEvent(ctx, db.ResolveAlertEventParams{ID: ev.ID, EndedAt: t0.Add(10 * time.Minute)})
	if err != nil || res.State != "resolved" || res.EndedAt == nil || res.NotifiedAt == nil || !res.NotifiedAt.Equal(t0.Add(2*time.Minute)) {
		t.Fatalf("resolve = %+v, %v", res, err)
	}
	if _, err := q.ResolveAlertEvent(ctx, db.ResolveAlertEventParams{ID: ev.ID, EndedAt: time.Now()}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("resolve twice = %v, want ErrNoRows", err)
	}
	if _, err := q.GetOpenAlertEvent(ctx, rule.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("open event after resolve = %v, want ErrNoRows", err)
	}
	ev2, err := q.OpenAlertEvent(ctx, db.OpenAlertEventParams{ID: uuid.New(), RuleID: rule.ID, Value: 900, StartedAt: t0.Add(30 * time.Minute)})
	if err != nil {
		t.Fatalf("reopen after resolve: %v", err)
	}

	feed, err := q.ListAlertEvents(ctx, db.ListAlertEventsParams{ProjectID: project, RowLimit: 1})
	if err != nil || len(feed) != 1 || feed[0].ID != ev2.ID || feed[0].RuleName != "High error rate" || feed[0].Metric != "p95" {
		t.Fatalf("feed page 1 = %+v, %v", feed, err)
	}
	feed, err = q.ListAlertEvents(ctx, db.ListAlertEventsParams{ProjectID: project, BeforeStartedAt: &feed[0].StartedAt, BeforeID: &feed[0].ID, RowLimit: 10})
	if err != nil || len(feed) != 1 || feed[0].ID != ev.ID {
		t.Fatalf("feed page 2 = %+v, %v", feed, err)
	}
	if feed, err := q.ListAlertEvents(ctx, db.ListAlertEventsParams{ProjectID: other, RowLimit: 10}); err != nil || len(feed) != 0 {
		t.Fatalf("feed of another project = %+v, %v; want none", feed, err)
	}

	// Deleting a rule deletes its events.
	if n, err := q.DeleteAlertRule(ctx, db.DeleteAlertRuleParams{ProjectID: other, ID: rule.ID}); err != nil || n != 0 {
		t.Fatalf("delete rule of another project = %d, %v; want 0", n, err)
	}
	if n, err := q.DeleteAlertRule(ctx, db.DeleteAlertRuleParams{ProjectID: project, ID: rule.ID}); err != nil || n != 1 {
		t.Fatalf("delete rule = %d, %v", n, err)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM alert_events WHERE rule_id = $1`, rule.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("events after rule delete = %d, %v; want 0", left, err)
	}
}
