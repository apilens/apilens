//go:build integration

package query_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/app"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// TestRetention runs `apilens migrate -only=clickhouse` with retention.*
// overrides and reads the resulting TTLs back through
// GET /api/v1/projects/{project}/retention: lengthening applies directly,
// shortening fails without -confirm-retention-change and applies with it.
func TestRetention(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)

	migrate := func(extraEnv []string, args ...string) (int, string) {
		env := append([]string{
			"APILENS_CLICKHOUSE__ADDR=" + strings.Join(chCfg.Addr, ","),
			"APILENS_CLICKHOUSE__DATABASE=" + chCfg.Database,
			"APILENS_CLICKHOUSE__USERNAME=" + chCfg.Username,
			"APILENS_CLICKHOUSE__PASSWORD=" + chCfg.Password,
			"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
			"APILENS_LOG__FORMAT=text",
		}, extraEnv...)
		var stderr bytes.Buffer
		code := app.Main(append([]string{"migrate", "-only=clickhouse"}, args...), io.Discard, &stderr, env)
		return code, stderr.String()
	}
	if code, out := migrate(nil); code != 0 {
		t.Fatalf("migrate: exit %d: %s", code, out)
	}

	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	shop, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"}); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	api := srv.API()
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(hc huma.Context, next func(huma.Context)) {
		if id, err := uuid.Parse(hc.Header(testUserHeader)); err == nil {
			hc = huma.WithContext(hc, authn.WithPrincipal(hc.Context(), authn.Principal{Kind: authn.KindUser, UserID: id, SessionID: uuid.New(), AMR: []string{"otp"}}))
		}
		next(hc)
	})
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	guard := authz.NewGuard(projectChecker{shop.ProjectID.String(): true}, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	query.Register(api, query.NewService(conn, q), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	user := uuid.NewString()
	get := func(slug string) (int, query.Retention) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/projects/"+slug+"/retention", nil)
		req.Header.Set(testUserHeader, user)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var out query.Retention
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode, out
	}
	periods := func() map[string]int {
		t.Helper()
		code, r := get("shop")
		if code != http.StatusOK {
			t.Fatalf("retention = %d", code)
		}
		out := map[string]int{}
		for _, s := range r.Signals {
			out[s.Key] = s.PeriodDays
			if s.Label == "" || s.Covers == "" || s.Configurable != (s.Key != "deploys") {
				t.Errorf("signal %+v: want label, covers, configurable unless deploys", s)
			}
		}
		return out
	}

	// Defaults: the periods the schema was created with.
	want := map[string]int{"requests": 90, "logs": 30, "spans": 30, "rollups_1m": 30, "rollups_1h": 400, "deploys": 400}
	if got := periods(); !maps.Equal(got, want) {
		t.Fatalf("default retention = %v, want %v", got, want)
	}

	// Lengthening needs no confirmation.
	if code, out := migrate([]string{"APILENS_RETENTION__REQUESTS=120", "APILENS_RETENTION__ROLLUPS_1H=730"}); code != 0 {
		t.Fatalf("lengthen: exit %d: %s", code, out)
	}
	want["requests"], want["rollups_1h"] = 120, 730
	if got := periods(); !maps.Equal(got, want) {
		t.Fatalf("after lengthening = %v, want %v", got, want)
	}

	// Shortening without the flag fails, names the table and the flag, and
	// changes nothing (not even the lengthening in the same run).
	shorten := []string{"APILENS_RETENTION__REQUESTS=120", "APILENS_RETENTION__ROLLUPS_1H=730", "APILENS_RETENTION__LOGS=7", "APILENS_RETENTION__SPANS=60"}
	code, out := migrate(shorten)
	if code == 0 || !strings.Contains(out, "retention.logs 30 -> 7 days (table api_logs)") || !strings.Contains(out, "-confirm-retention-change") {
		t.Fatalf("shorten without flag: exit %d: %s", code, out)
	}
	if got := periods(); !maps.Equal(got, want) {
		t.Fatalf("after refused shortening = %v, want %v", got, want)
	}

	// With the flag it applies and logs a warning naming the table.
	code, out = migrate(shorten, "--confirm-retention-change")
	if code != 0 || !strings.Contains(out, "level=WARN") || !strings.Contains(out, "table=api_logs") {
		t.Fatalf("shorten with flag: exit %d: %s", code, out)
	}
	want["logs"], want["spans"] = 7, 60
	if got := periods(); !maps.Equal(got, want) {
		t.Fatalf("after shortening = %v, want %v", got, want)
	}

	// Retention is per install, but reading it still needs view on the project.
	if code, _ := get("bank"); code != http.StatusNotFound {
		t.Errorf("project without view = %d, want 404", code)
	}
}
