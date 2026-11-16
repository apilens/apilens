//go:build integration

package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	appsvc "github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/config"
)

// recordingSink keeps the request rows the edge submits.
type recordingSink struct {
	mu       sync.Mutex
	requests []pipeline.RequestRow
}

func (s *recordingSink) SubmitRequests(_ context.Context, rows []pipeline.RequestRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, rows...)
	return nil
}
func (s *recordingSink) SubmitLogs(context.Context, []pipeline.LogRow) error       { return nil }
func (s *recordingSink) SubmitSpans(context.Context, []pipeline.SpanRow) error     { return nil }
func (s *recordingSink) SubmitDeploys(context.Context, []pipeline.DeployRow) error { return nil }

// A project created through the API accepts events straight away with the
// project's ingest key and app_id = the project slug, as the onboarding
// install screen tells SDKs to send them (the default app).
func TestNewProjectAcceptsEventsWithSlugAppID(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "ingest-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	p := f.mustCreateProject(t, owner, "acme", "Checkout", "checkout")
	key := f.mustCreateKey(t, owner, "checkout", "Install", "ingest")

	sink := &recordingSink{}
	apps := catalog.NewAppResolver(db.New(f.pool), time.Minute).WithProvisioner(appsvc.NewProvisioner(f.pool, nil, appsvc.Limits{}))
	edge := ingest.New(f.verifier, apps, sink, config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000},
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	mux := http.NewServeMux()
	edge.Register(mux)

	send := func(appID string) *httptest.ResponseRecorder {
		ts := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
		body := `{"requests":[{"project_slug":"checkout","app_id":"` + appID + `","timestamp":"` + ts +
			`","method":"GET","path":"/orders/{id}","status_code":200,"response_time_ms":3}]}`
		req := httptest.NewRequest(http.MethodPost, "/v1/requests", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", key.Key)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	if rec := send("checkout"); rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"accepted":1}` {
		t.Fatalf("app_id = slug: %d %s", rec.Code, rec.Body)
	}
	var appID string
	if err := f.pool.QueryRow(f.ctx, `SELECT id::text FROM apps WHERE project_id = $1 AND slug = 'checkout'`, p.ID).Scan(&appID); err != nil {
		t.Fatal(err)
	}
	if len(sink.requests) != 1 || sink.requests[0].ProjectID.String() != p.ID || sink.requests[0].AppID.String() != appID {
		t.Fatalf("rows = %+v, want project %s app %s", sink.requests, p.ID, appID)
	}

	// Other app names create the app (the key may create apps by default).
	if rec := send("ghost"); rec.Code != http.StatusOK {
		t.Fatalf("unknown app: %d %s", rec.Code, rec.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM apps WHERE project_id = $1 AND slug = 'ghost' AND created_by = 'sdk'`, p.ID); n != 1 {
		t.Fatalf("ghost app rows = %d", n)
	}
}
