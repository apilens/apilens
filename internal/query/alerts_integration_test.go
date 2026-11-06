//go:build integration

package query_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// fakeTester records the test notifications it is asked to send, fails
// them with a DeliveryError while fail is set and with err when set.
type fakeTester struct {
	mu   sync.Mutex
	sent []query.TestNotification
	fail bool
	err  error
}

func (f *fakeTester) SendTest(_ context.Context, n query.TestNotification) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	if f.fail {
		return &alerts.DeliveryError{Status: http.StatusNotFound}
	}
	f.sent = append(f.sent, n)
	return nil
}

func (f *fakeTester) setFail(fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = fail
}

func (f *fakeTester) setErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeTester) sentSoFar() []query.TestNotification {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]query.TestNotification(nil), f.sent...)
}

// TestAlertsAPI drives the alert rules, channels, events and incidents
// operations through the API against Postgres and a real SpiceDB: project
// admins write, members and the read key read, strangers never learn the
// project exists, and channel configs are sealed and never returned.
func TestAlertsAPI(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
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
	other, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "globex", ProjectSlug: "billing", AppSlug: "invoices", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	admin, member, outsider := uuid.New(), uuid.New(), uuid.New()
	for i, u := range []uuid.UUID{admin, member, outsider} {
		email := []string{"admin@example.com", "member@example.com", "outsider@example.com"}[i]
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, u, email); err != nil {
			t.Fatal(err)
		}
	}
	client := authz.New(sdb, nil, authz.Options{}, logger, nil)
	if _, err := client.WriteRelationships(ctx, seed.OrgID.String(), []*v1.RelationshipUpdate{
		touch("project", seed.ProjectID.String(), "org", "organization", seed.OrgID.String()),
		touch("organization", seed.OrgID.String(), "admin", "user", admin.String()),
		touch("organization", seed.OrgID.String(), "member", "user", member.String()),
	}); err != nil {
		t.Fatal(err)
	}

	kek := make([]byte, keys.KEKSize)
	copy(kek, "test-only-alerts-kek-0123456789!")
	sealer, err := keys.NewSealer(kek)
	if err != nil {
		t.Fatal(err)
	}
	tester := &fakeTester{}

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
	query.Register(api, query.NewService(nil, q).WithAlerts(pool, sealer, tester), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// do sends a request as user ("" = the project read key) and decodes a
	// 2xx JSON answer into out.
	do := func(method, path string, user uuid.UUID, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		if user != uuid.Nil {
			req.Header.Set("X-Test-User", user.String())
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
		raw, _ := io.ReadAll(resp.Body)
		if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), "hooks.slack.com") {
			t.Fatalf("%s %s leaked a channel secret: %s", method, path, raw)
		}
		if out != nil && resp.StatusCode/100 == 2 {
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	expect := func(want, got int, what string) {
		t.Helper()
		if got != want {
			t.Fatalf("%s: status %d, want %d", what, got, want)
		}
	}

	const base = "/api/v1/projects/shop"
	type channel struct {
		ID     string         `json:"id"`
		Type   string         `json:"type"`
		Name   string         `json:"name"`
		Config map[string]any `json:"config"`
	}
	slack := map[string]any{"type": "slack", "name": "#ops", "config": map[string]any{"webhook_url": "https://hooks.slack.com/services/T0/B0/SECRET"}}
	email := map[string]any{"type": "email", "name": "On-call", "config": map[string]any{"addresses": []string{"oncall@example.com"}}}

	// Channels: admins write, members and the read key read.
	expect(http.StatusForbidden, do(http.MethodPost, base+"/alerts/channels", member, slack, nil), "member creates channel")
	expect(http.StatusNotFound, do(http.MethodPost, base+"/alerts/channels", outsider, slack, nil), "outsider creates channel")
	var ops, oncall channel
	expect(http.StatusCreated, do(http.MethodPost, base+"/alerts/channels", admin, slack, &ops), "admin creates slack channel")
	expect(http.StatusCreated, do(http.MethodPost, base+"/alerts/channels", admin, email, &oncall), "admin creates email channel")
	if ops.Type != "slack" || ops.Name != "#ops" || ops.Config != nil {
		t.Fatalf("created channel = %+v", ops)
	}
	expect(http.StatusConflict, do(http.MethodPost, base+"/alerts/channels", admin, slack, nil), "duplicate channel name")
	expect(http.StatusUnprocessableEntity, do(http.MethodPost, base+"/alerts/channels", admin,
		map[string]any{"type": "slack", "name": "bad", "config": map[string]any{"webhook_url": "http://example.com"}}, nil), "plain-http slack url")
	var sealed []byte
	if err := pool.QueryRow(ctx, `SELECT config_enc FROM notification_channels WHERE id = $1`, ops.ID).Scan(&sealed); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("hooks.slack.com")) {
		t.Fatal("channel config stored in the clear")
	}
	var channels struct {
		Channels []channel `json:"channels"`
	}
	for _, u := range []uuid.UUID{member, uuid.Nil} {
		expect(http.StatusOK, do(http.MethodGet, base+"/alerts/channels", u, nil, &channels), "list channels")
		if len(channels.Channels) != 2 || channels.Channels[0].Name != "#ops" || channels.Channels[1].Name != "On-call" {
			t.Fatalf("channels = %+v", channels.Channels)
		}
	}
	expect(http.StatusNotFound, do(http.MethodGet, base+"/alerts/channels", outsider, nil, nil), "outsider lists channels")
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/channels/"+ops.ID, member, nil, &channel{}), "member gets channel")
	expect(http.StatusNotFound, do(http.MethodGet, base+"/alerts/channels/"+uuid.NewString(), member, nil, nil), "unknown channel")

	// Renaming without a config keeps the sealed one.
	var renamed channel
	expect(http.StatusOK, do(http.MethodPut, base+"/alerts/channels/"+ops.ID, admin, map[string]any{"name": "#ops-alerts"}, &renamed), "rename channel")
	expect(http.StatusForbidden, do(http.MethodPut, base+"/alerts/channels/"+ops.ID, member, map[string]any{"name": "x"}, nil), "member renames channel")
	expect(http.StatusConflict, do(http.MethodPut, base+"/alerts/channels/"+ops.ID, admin, map[string]any{"name": "On-call"}, nil), "rename onto a used name")
	row, err := q.GetNotificationChannel(ctx, db.GetNotificationChannelParams{ProjectID: seed.ProjectID, ID: uuid.MustParse(ops.ID)})
	if err != nil {
		t.Fatal(err)
	}
	if cfg, err := alerts.OpenChannelConfig(sealer, row.ID, row.ConfigEnc); err != nil || !strings.Contains(string(cfg), "B0/SECRET") || row.Name != "#ops-alerts" {
		t.Fatalf("after rename: %s %q, %v", cfg, row.Name, err)
	}

	// Test notifications.
	expect(http.StatusForbidden, do(http.MethodPost, base+"/alerts/channels/"+ops.ID+"/test", member, nil, nil), "member tests channel")
	expect(http.StatusOK, do(http.MethodPost, base+"/alerts/channels/"+ops.ID+"/test", admin, nil, nil), "admin tests channel")
	sent := tester.sentSoFar()
	if len(sent) != 1 || sent[0].Type != alerts.ChannelSlack || sent[0].ProjectID != seed.ProjectID ||
		!strings.Contains(string(sent[0].Config), "B0/SECRET") {
		t.Fatalf("sent = %+v", sent)
	}
	tester.setFail(true)
	expect(http.StatusBadGateway, do(http.MethodPost, base+"/alerts/channels/"+ops.ID+"/test", admin, nil, nil), "failing test notification")
	// Any other failure may carry secrets and is reduced to a generic answer.
	tester.setErr(errors.New("POST https://hooks.slack.com/services/T0/B0/SECRET: dial tcp: refused"))
	expect(http.StatusBadGateway, do(http.MethodPost, base+"/alerts/channels/"+ops.ID+"/test", admin, nil, nil), "failing test notification, raw error")
	tester.setErr(nil)
	tester.setFail(false)

	// Rules.
	type rule struct {
		ID         string   `json:"id"`
		Name       string   `json:"name"`
		Metric     string   `json:"metric"`
		EveryS     *int32   `json:"every_s"`
		Cron       *string  `json:"cron"`
		ChannelIDs []string `json:"channel_ids"`
		Enabled    bool     `json:"enabled"`
		CreatedBy  *string  `json:"created_by"`
		Filters    struct {
			Group    string `json:"group"`
			Endpoint string `json:"endpoint"`
		} `json:"filters"`
		State *struct {
			Status string   `json:"status"`
			Value  *float64 `json:"value"`
		} `json:"state"`
	}
	newRule := map[string]any{
		"app_id": seed.AppID, "environment": "production", "name": "Slow checkout", "metric": "p95",
		"condition": "gt", "threshold": 800, "window_s": 300, "every_s": 60, "notify_after_s": 120,
		"filters":     map[string]any{"endpoint": "POST /checkout"},
		"channel_ids": []string{ops.ID, oncall.ID},
	}
	expect(http.StatusForbidden, do(http.MethodPost, base+"/alerts/rules", member, newRule, nil), "member creates rule")
	expect(http.StatusUnauthorized, do(http.MethodPost, base+"/alerts/rules", uuid.Nil, newRule, nil), "read key creates rule")
	var slow rule
	expect(http.StatusCreated, do(http.MethodPost, base+"/alerts/rules", admin, newRule, &slow), "admin creates rule")
	if slow.Name != "Slow checkout" || !slow.Enabled || slow.State != nil || len(slow.ChannelIDs) != 2 || slow.CreatedBy == nil || *slow.CreatedBy != admin.String() {
		t.Fatalf("created rule = %+v", slow)
	}
	for what, mutate := range map[string]func(m map[string]any){
		"other project's app":     func(m map[string]any) { m["app_id"] = other.AppID },
		"other project's channel": func(m map[string]any) { m["channel_ids"] = []string{uuid.NewString()} },
		"both schedules":          func(m map[string]any) { m["cron"] = "*/5 * * * *" },
		"group name too long":     func(m map[string]any) { m["filters"] = map[string]any{"group": strings.Repeat("g", 257)} },
	} {
		body := map[string]any{}
		for k, v := range newRule {
			body[k] = v
		}
		mutate(body)
		expect(http.StatusUnprocessableEntity, do(http.MethodPost, base+"/alerts/rules", admin, body, nil), what)
	}

	var rules struct {
		Rules []rule `json:"rules"`
	}
	for _, u := range []uuid.UUID{member, uuid.Nil} {
		expect(http.StatusOK, do(http.MethodGet, base+"/alerts/rules", u, nil, &rules), "list rules")
		if len(rules.Rules) != 1 || rules.Rules[0].ID != slow.ID {
			t.Fatalf("rules = %+v", rules.Rules)
		}
	}
	expect(http.StatusNotFound, do(http.MethodGet, base+"/alerts/rules", outsider, nil, nil), "outsider lists rules")

	// Replace: cron schedule, disabled, one channel.
	update := map[string]any{
		"environment": "production", "name": "Slow checkout (business hours)", "metric": "p95", "condition": "gte",
		"threshold": 1000, "window_s": 600, "cron": "*/5 9-17 * * 1-5", "enabled": false, "channel_ids": []string{oncall.ID},
		// An SDK consumer group by name, trimmed; one the SDK has not
		// reported yet is accepted.
		"filters": map[string]any{"group": "  Acme Corp ", "endpoint": "POST /checkout"},
	}
	expect(http.StatusForbidden, do(http.MethodPut, base+"/alerts/rules/"+slow.ID, member, update, nil), "member replaces rule")
	var updated rule
	expect(http.StatusOK, do(http.MethodPut, base+"/alerts/rules/"+slow.ID, admin, update, &updated), "admin replaces rule")
	if updated.EveryS != nil || updated.Cron == nil || updated.Enabled || len(updated.ChannelIDs) != 1 || updated.ChannelIDs[0] != oncall.ID ||
		updated.Filters.Group != "Acme Corp" || updated.Filters.Endpoint != "POST /checkout" {
		t.Fatalf("updated rule = %+v", updated)
	}

	// Events and incidents, as the evaluator records them.
	ruleID := uuid.MustParse(slow.ID)
	now := time.Now().UTC().Truncate(time.Microsecond)
	open := func(started time.Time, value float64) db.AlertEvent {
		t.Helper()
		e, err := q.OpenAlertEvent(ctx, db.OpenAlertEventParams{ID: uuid.New(), RuleID: ruleID, Value: value, StartedAt: started})
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	for i, started := range []time.Time{now.Add(-10 * 24 * time.Hour), now.Add(-3 * time.Hour), now.Add(-2 * time.Hour)} {
		e := open(started, 900+float64(i))
		if _, err := q.ResolveAlertEvent(ctx, db.ResolveAlertEventParams{ID: e.ID, EndedAt: started.Add(10 * time.Minute)}); err != nil {
			t.Fatal(err)
		}
	}
	latest := open(now.Add(-time.Minute), 1200)
	v := 1200.0
	if err := q.UpsertAlertRuleState(ctx, db.UpsertAlertRuleStateParams{
		RuleID: ruleID, EvaluatedAt: now, WindowStart: now.Add(-10 * time.Minute), WindowEnd: now,
		Value: &v, Requests: 50, Breached: true, Status: string(alerts.StatusTriggered), StatusSince: now.Add(-time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	var got rule
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/rules/"+slow.ID, member, nil, &got), "get rule")
	if got.State == nil || got.State.Status != "triggered" || got.State.Value == nil || *got.State.Value != 1200 {
		t.Fatalf("rule state = %+v", got.State)
	}

	type event struct {
		ID      string `json:"id"`
		RuleID  string `json:"rule_id"`
		State   string `json:"state"`
		EndedAt *time.Time
	}
	type eventsPage struct {
		Events     []event `json:"events"`
		NextCursor string  `json:"next_cursor"`
	}
	var page eventsPage
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/events?limit=3", uuid.Nil, nil, &page), "events page 1")
	if len(page.Events) != 3 || page.Events[0].ID != latest.ID.String() || page.NextCursor == "" {
		t.Fatalf("page 1 = %+v", page)
	}
	var page2 eventsPage
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/events?limit=3&cursor="+page.NextCursor, member, nil, &page2), "events page 2")
	if len(page2.Events) != 1 || page2.NextCursor != "" {
		t.Fatalf("page 2 = %+v", page2)
	}
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/events?state=triggered&rule_id="+slow.ID, member, nil, &page), "open events")
	if len(page.Events) != 1 || page.Events[0].State != "triggered" {
		t.Fatalf("open events = %+v", page.Events)
	}
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/events?rule_id="+uuid.NewString(), member, nil, &page), "events of another rule")
	if len(page.Events) != 0 {
		t.Fatalf("events of an unknown rule = %+v", page.Events)
	}
	expect(http.StatusUnprocessableEntity, do(http.MethodGet, base+"/alerts/events?cursor=!!", member, nil, nil), "bad cursor")
	expect(http.StatusNotFound, do(http.MethodGet, base+"/alerts/events", outsider, nil, nil), "outsider lists events")

	var incidents struct {
		Range     string `json:"range"`
		Incidents []struct {
			RuleID string `json:"rule_id"`
			Status string `json:"status"`
			Open   bool   `json:"open"`
			Events int64  `json:"events"`
			Latest event  `json:"latest"`
		} `json:"incidents"`
	}
	expect(http.StatusOK, do(http.MethodGet, base+"/incidents", member, nil, &incidents), "incidents")
	if incidents.Range != "7d" || len(incidents.Incidents) != 1 {
		t.Fatalf("incidents = %+v", incidents)
	}
	inc := incidents.Incidents[0]
	// The event from ten days ago is outside the 7d range.
	if inc.RuleID != slow.ID || inc.Status != "triggered" || !inc.Open || inc.Events != 3 || inc.Latest.ID != latest.ID.String() {
		t.Fatalf("incident = %+v", inc)
	}
	expect(http.StatusOK, do(http.MethodGet, base+"/incidents?range=30d", uuid.Nil, nil, &incidents), "incidents 30d")
	if len(incidents.Incidents) != 1 || incidents.Incidents[0].Events != 4 {
		t.Fatalf("incidents 30d = %+v", incidents)
	}
	expect(http.StatusNotFound, do(http.MethodGet, base+"/incidents", outsider, nil, nil), "outsider incidents")

	// Deleting a channel takes it off the rules that notify it.
	expect(http.StatusForbidden, do(http.MethodDelete, base+"/alerts/channels/"+oncall.ID, member, nil, nil), "member deletes channel")
	expect(http.StatusNoContent, do(http.MethodDelete, base+"/alerts/channels/"+oncall.ID, admin, nil, nil), "admin deletes channel")
	expect(http.StatusNotFound, do(http.MethodDelete, base+"/alerts/channels/"+oncall.ID, admin, nil, nil), "delete channel twice")
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/rules/"+slow.ID, member, nil, &got), "rule after channel delete")
	if len(got.ChannelIDs) != 0 {
		t.Fatalf("rule still notifies the deleted channel: %v", got.ChannelIDs)
	}

	// Deleting a rule deletes its events.
	expect(http.StatusForbidden, do(http.MethodDelete, base+"/alerts/rules/"+slow.ID, member, nil, nil), "member deletes rule")
	expect(http.StatusNoContent, do(http.MethodDelete, base+"/alerts/rules/"+slow.ID, admin, nil, nil), "admin deletes rule")
	expect(http.StatusNotFound, do(http.MethodGet, base+"/alerts/rules/"+slow.ID, member, nil, nil), "deleted rule")
	expect(http.StatusOK, do(http.MethodGet, base+"/alerts/events", member, nil, &page), "events after rule delete")
	if len(page.Events) != 0 {
		t.Fatalf("events after rule delete = %+v", page.Events)
	}
}
