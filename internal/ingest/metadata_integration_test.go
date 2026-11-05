//go:build integration

package ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/testutil"
)

// TestMetadataStoredInPostgres runs POST /v1/metadata against the real
// migration and query: one row per app and environment, replaced by the
// next report, and the app's framework set only while it is empty.
func TestMetadataStoredInPostgres(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 10, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	mux := http.NewServeMux()
	New(verifier, catalog.NewAppResolver(q, time.Minute), &fakeSink{}, cfg, logger, nil).WithMetadata(q).Register(mux)

	send := func(body string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/v1/metadata", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", seed.APIKey)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST /v1/metadata: %d %s", rec.Code, rec.Body)
		}
	}
	type stored struct {
		framework, frameworkVersion, runtime, sdk, routes, config, appFramework string
		rows                                                                     int
	}
	read := func() stored {
		t.Helper()
		var s stored
		err := pool.QueryRow(ctx, `
			SELECT m.framework, m.framework_version, m.runtime_version, m.sdk_version, m.routes::text, m.config::text,
			       a.framework, (SELECT count(*) FROM app_metadata WHERE app_id = a.id)
			FROM app_metadata m JOIN apps a ON a.id = m.app_id
			WHERE m.app_id = $1 AND m.environment = 'production'`, seed.AppID).
			Scan(&s.framework, &s.frameworkVersion, &s.runtime, &s.sdk, &s.routes, &s.config, &s.appFramework, &s.rows)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	send(`{"app_id":"storefront","framework":"fastapi","framework_version":"0.115.0","python_version":"3.13.1",
	  "sdk_version":"0.5.0","routes":[{"method":"GET","path":"/orders/{id}"}],"config":{"sample_rate":1}}`)
	got := read()
	if got.framework != "fastapi" || got.frameworkVersion != "0.115.0" || got.runtime != "3.13.1" || got.sdk != "0.5.0" ||
		got.routes != `[{"path": "/orders/{id}", "method": "GET"}]` || got.config != `{"sample_rate": 1}` ||
		got.appFramework != "fastapi" || got.rows != 1 {
		t.Fatalf("first report = %+v", got)
	}

	// The next report replaces the row; the app keeps its first framework.
	send(`{"app_id":"` + seed.AppID.String() + `","framework":"starlette","sdk_version":"0.6.0"}`)
	got = read()
	if got.framework != "starlette" || got.sdk != "0.6.0" || got.routes != "[]" || got.config != "{}" ||
		got.appFramework != "fastapi" || got.rows != 1 {
		t.Fatalf("second report = %+v", got)
	}

	// Another environment is a separate row.
	send(`{"app_id":"storefront","environment":"staging"}`)
	if got = read(); got.rows != 2 {
		t.Fatalf("rows after staging report = %d", got.rows)
	}
}
