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
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// allowProject grants every permission on one project to every user.
type allowProject string

func (a allowProject) Check(_ context.Context, _ authz.Object, _ authz.Permission, res authz.Resource) (bool, error) {
	return res.Type == authz.TypeProject && res.ID == string(a), nil
}

// TestQueryAuditEvents changes alert rules, channels, health checks, app
// settings and endpoint settings through the API and checks that each
// change records its audit event with the project scope, the target, the
// actor and the previous and next values, and never a channel secret or a
// health check URL's query.
func TestQueryAuditEvents(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)

	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	admin := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, 'admin@example.com')`, admin); err != nil {
		t.Fatal(err)
	}

	kek := make([]byte, keys.KEKSize)
	copy(kek, "test-only-alerts-kek-0123456789!")
	sealer, err := keys.NewSealer(kek)
	if err != nil {
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
	guard := authz.NewGuard(allowProject(seed.ProjectID.String()), authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	svc := query.NewService(nil, q).WithAlerts(pool, sealer, &fakeTester{}).WithAudit(pool, audit.New(pool))
	query.Register(api, svc, guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	do := func(method, path string, body, out any) {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		req.Header.Set("X-Test-User", admin.String())
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode/100 != 2 {
			t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
		}
		if out != nil {
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatal(err)
			}
		}
	}

	// last returns the newest event of kind and checks its scope, actor
	// and target.
	last := func(kind audit.Kind, targetType, targetID string) map[string]any {
		t.Helper()
		var (
			org, project, actor *uuid.UUID
			typ, id             *string
			changes             []byte
		)
		err := pool.QueryRow(ctx, `SELECT org_id, project_id, actor_user_id, target_type, target_id, changes
			FROM audit_events WHERE event = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, string(kind)).
			Scan(&org, &project, &actor, &typ, &id, &changes)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if org == nil || *org != seed.OrgID || project == nil || *project != seed.ProjectID || actor == nil || *actor != admin {
			t.Fatalf("%s scope: org %v project %v actor %v", kind, org, project, actor)
		}
		if typ == nil || *typ != targetType || id == nil || *id != targetID {
			t.Fatalf("%s target: %v %v, want %s %s", kind, typ, id, targetType, targetID)
		}
		for _, secret := range []string{"SECRET", "hooks.slack.com", "token=abc"} {
			if strings.Contains(string(changes), secret) {
				t.Fatalf("%s changes hold a secret: %s", kind, changes)
			}
		}
		var c map[string]any
		if err := json.Unmarshal(changes, &c); err != nil {
			t.Fatalf("%s changes %s: %v", kind, changes, err)
		}
		return c
	}
	side := func(c map[string]any, which string) map[string]any {
		t.Helper()
		m, _ := c[which].(map[string]any)
		return m
	}

	const base = "/api/v1/projects/shop"
	type ided struct {
		ID string `json:"id"`
	}

	// Channels.
	var ch ided
	do(http.MethodPost, base+"/alerts/channels", map[string]any{
		"type": "slack", "name": "#ops", "config": map[string]any{"webhook_url": "https://hooks.slack.com/services/T0/B0/SECRET"},
	}, &ch)
	c := last(audit.AlertChannelCreated, "alert_channel", ch.ID)
	if c["previous"] != nil || side(c, "next")["name"] != "#ops" || side(c, "next")["type"] != "slack" {
		t.Fatalf("alert_channel.created changes = %v", c)
	}
	do(http.MethodPut, base+"/alerts/channels/"+ch.ID, map[string]any{
		"name": "#ops-alerts", "config": map[string]any{"webhook_url": "https://hooks.slack.com/services/T0/B1/SECRET"},
	}, nil)
	c = last(audit.AlertChannelUpdated, "alert_channel", ch.ID)
	if side(c, "previous")["name"] != "#ops" || side(c, "next")["name"] != "#ops-alerts" || side(c, "next")["config_replaced"] != true {
		t.Fatalf("alert_channel.updated changes = %v", c)
	}

	// Rules.
	var rule ided
	do(http.MethodPost, base+"/alerts/rules", map[string]any{
		"app_id": seed.AppID, "environment": "production", "name": "Slow checkout", "metric": "p95",
		"condition": "gt", "threshold": 800, "window_s": 300, "every_s": 60, "channel_ids": []string{ch.ID},
	}, &rule)
	c = last(audit.AlertRuleCreated, "alert_rule", rule.ID)
	if c["previous"] != nil || side(c, "next")["name"] != "Slow checkout" || side(c, "next")["threshold"] != 800.0 {
		t.Fatalf("alert_rule.created changes = %v", c)
	}
	do(http.MethodPut, base+"/alerts/rules/"+rule.ID, map[string]any{
		"environment": "production", "name": "Slow checkout", "metric": "p95",
		"condition": "gt", "threshold": 900, "window_s": 300, "every_s": 60, "channel_ids": []string{ch.ID},
	}, nil)
	c = last(audit.AlertRuleUpdated, "alert_rule", rule.ID)
	if prev, next := side(c, "previous"), side(c, "next"); prev["threshold"] != 800.0 || next["threshold"] != 900.0 || len(prev) != 1 || len(next) != 1 {
		t.Fatalf("alert_rule.updated changes = %v, want only the threshold", c)
	}
	do(http.MethodDelete, base+"/alerts/rules/"+rule.ID, nil, nil)
	c = last(audit.AlertRuleDeleted, "alert_rule", rule.ID)
	if c["next"] != nil || side(c, "previous")["name"] != "Slow checkout" {
		t.Fatalf("alert_rule.deleted changes = %v", c)
	}
	do(http.MethodDelete, base+"/alerts/channels/"+ch.ID, nil, nil)
	c = last(audit.AlertChannelDeleted, "alert_channel", ch.ID)
	if c["next"] != nil || side(c, "previous")["name"] != "#ops-alerts" {
		t.Fatalf("alert_channel.deleted changes = %v", c)
	}

	// Health checks: the URL is recorded without its query.
	var hc ided
	do(http.MethodPost, base+"/alerts/health-checks", map[string]any{
		"app_id": seed.AppID, "environment": "production", "url": "https://status.example.com/health?token=abc",
	}, &hc)
	c = last(audit.HealthCheckCreated, "health_check", hc.ID)
	if c["previous"] != nil || side(c, "next")["url"] != "https://status.example.com/health" || side(c, "next")["expected_status"] != 200.0 {
		t.Fatalf("health_check.created changes = %v", c)
	}
	do(http.MethodDelete, base+"/alerts/health-checks/"+hc.ID, nil, nil)
	c = last(audit.HealthCheckDeleted, "health_check", hc.ID)
	if c["next"] != nil || side(c, "previous")["url"] != "https://status.example.com/health" {
		t.Fatalf("health_check.deleted changes = %v", c)
	}

	// App settings.
	do(http.MethodPut, "/api/v1/apps/"+seed.AppID.String()+"/settings", map[string]any{"latency_threshold_ms": 300}, nil)
	c = last(audit.AppSettingsUpdated, "app", seed.AppID.String())
	if side(c, "previous")["latency_threshold_ms"] != nil || side(c, "next")["latency_threshold_ms"] != 300.0 {
		t.Fatalf("app_settings.updated changes = %v", c)
	}

	// Endpoint settings.
	do(http.MethodPut, "/api/v1/apps/"+seed.AppID.String()+"/endpoints/get/"+url.PathEscape("/orders/{id}")+"/settings",
		map[string]any{"expected_status_codes": []int{404}, "excluded": false}, nil)
	c = last(audit.EndpointSettingsUpdated, "endpoint", seed.AppID.String()+" GET /orders/{id}")
	if prev, next := side(c, "previous"), side(c, "next"); len(prev) != 1 || len(next) != 1 ||
		len(prev["expected_status_codes"].([]any)) != 0 || next["expected_status_codes"].([]any)[0] != 404.0 {
		t.Fatalf("endpoint_settings.updated changes = %v", c)
	}

	// Saving the same values again changes nothing and records nothing.
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE event = $1`, string(audit.AppSettingsUpdated)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	do(http.MethodPut, "/api/v1/apps/"+seed.AppID.String()+"/settings", map[string]any{"latency_threshold_ms": 300}, nil)
	var after int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE event = $1`, string(audit.AppSettingsUpdated)).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != n {
		t.Fatalf("an unchanged save recorded app_settings.updated (%d -> %d)", n, after)
	}
}
