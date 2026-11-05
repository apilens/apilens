//go:build integration

package query_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

// hookStore runs beforeWrite (when set) before each export file is written.
type hookStore struct {
	query.ExportStore
	mu          sync.Mutex
	beforeWrite func(key string)
}

func (h *hookStore) setBeforeWrite(f func(key string)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.beforeWrite = f
}

func (h *hookStore) Write(ctx context.Context, key string, fill func(io.Writer) error) (int64, error) {
	h.mu.Lock()
	f := h.beforeWrite
	h.mu.Unlock()
	if f != nil {
		f(key)
	}
	return h.ExportStore.Write(ctx, key, fill)
}

type exportBody struct {
	ID                   string         `json:"id"`
	Status               string         `json:"status"`
	Filter               map[string]any `json:"filter"`
	From                 time.Time      `json:"from"`
	To                   time.Time      `json:"to"`
	RowLimit             int64          `json:"row_limit"`
	TotalRows            *int64         `json:"total_rows"`
	RowsWritten          int64          `json:"rows_written"`
	Progress             float64        `json:"progress"`
	SizeBytes            int64          `json:"size_bytes"`
	Error                *string        `json:"error"`
	ExpiresAt            *time.Time     `json:"expires_at"`
	DownloadURL          *string        `json:"download_url"`
	DownloadURLExpiresAt *time.Time     `json:"download_url_expires_at"`
}

// TestRequestExports exports 10,000 request log rows through the API and a
// real River worker: progress and the signed download link, the CSV's
// contents (tenant scoped, newest first, no headers or bodies, redaction
// markers kept), who may see an export, cancellation and expiry.
func TestRequestExports(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}

	mine, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	alice, bob, outsider := uuid.New(), uuid.New(), uuid.New()
	for i, u := range []uuid.UUID{alice, bob, outsider} {
		email := []string{"alice@example.com", "bob@example.com", "outsider@example.com"}[i]
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, u, email); err != nil {
			t.Fatal(err)
		}
	}
	client := authz.New(sdb, nil, authz.Options{}, logger, nil)
	if _, err := client.WriteRelationships(ctx, mine.OrgID.String(), []*v1.RelationshipUpdate{
		touch("project", mine.ProjectID.String(), "org", "organization", mine.OrgID.String()),
		touch("organization", mine.OrgID.String(), "member", "user", alice.String()),
		touch("organization", mine.OrgID.String(), "member", "user", bob.String()),
	}); err != nil {
		t.Fatal(err)
	}

	// 10,000 rows of the last 50 minutes, each carrying secrets in its
	// headers and bodies, plus rows of another project that match too.
	const n = 10_000
	now := time.Now().UTC().Truncate(time.Millisecond)
	rows := make([]pipeline.RequestRow, 0, n+100)
	for i := range n {
		consumer := "acme-" + fmt.Sprint(i%7)
		if i == 0 {
			consumer = "=HYPERLINK(\"http://evil\")"
		}
		rows = append(rows, pipeline.RequestRow{
			ProjectID: mine.ProjectID, AppID: mine.AppID, Environment: "production",
			Timestamp: now.Add(-time.Duration(i) * 300 * time.Millisecond),
			Method:    "POST", Path: "/login", RawPath: fmt.Sprintf("/login?token=[redacted]&page=%d", i),
			StatusCode: 200, ResponseTimeMs: 12.5, RequestSize: 64, ResponseSize: 128, IPAddress: "10.0.0.1",
			ConsumerID: "c-" + fmt.Sprint(i%7), ConsumerName: consumer,
			RequestHeaders:  `{"authorization":"Bearer sk_live_SECRET"}`,
			ResponseHeaders: `{"set-cookie":"session=SECRET_COOKIE"}`,
			RequestPayload:  `{"password":"hunter2"}`, ResponsePayload: `{"token":"SECRET_TOKEN"}`,
			Sampled: true, TraceID: fmt.Sprintf("%032x", i+1), SpanID: fmt.Sprintf("%016x", i+1),
		})
	}
	for i := range 100 {
		rows = append(rows, pipeline.RequestRow{
			ProjectID: theirs.ProjectID, AppID: theirs.AppID, Environment: "production", Timestamp: now.Add(-time.Duration(i) * time.Second),
			Method: "GET", Path: "/accounts", RawPath: "/accounts", StatusCode: 200, Sampled: true, TraceID: fmt.Sprintf("%032x", 1_000_000+i),
		})
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, rows); err != nil {
		t.Fatal(err)
	}

	// The River client works the exports queue once started below.
	store, err := query.NewLocalExportStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	hooked := &hookStore{ExportStore: store}
	registry := jobs.NewRegistry()
	registry.Queue(query.ExportQueue, query.ExportQueueWorkers)
	jobs.Register(registry, query.NewExportWorker(conn, pool, hooked, logger))
	jobClient, err := jobs.New(pool, config.JobsConfig{Enabled: true, MaxWorkers: 2, MetricsInterval: time.Second}, registry, 10*time.Second, logger, nil)
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
	guard := authz.NewGuard(client, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	query.Register(api, query.NewService(conn, q).WithExports(pool, jobClient, hooked), guard)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

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
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode/100 == 2 {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	const exports = "/api/v1/projects/shop/exports"
	create := func(user uuid.UUID, filter map[string]any) exportBody {
		t.Helper()
		var e exportBody
		if code := do(http.MethodPost, exports, user, filter, &e); code != http.StatusAccepted {
			t.Fatalf("create export: %d", code)
		}
		return e
	}
	get := func(id string) exportBody {
		t.Helper()
		var e exportBody
		if code := do(http.MethodGet, "/api/v1/exports/"+id, alice, nil, &e); code != http.StatusOK {
			t.Fatalf("get export: %d", code)
		}
		return e
	}
	waitFor := func(id string, done func(exportBody) bool) exportBody {
		t.Helper()
		deadline := time.Now().Add(60 * time.Second)
		for {
			e := get(id)
			if done(e) {
				return e
			}
			if time.Now().After(deadline) {
				t.Fatalf("export %s stuck: %+v", id, e)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}

	// A queued export cancelled before a worker runs it never runs.
	early := create(alice, map[string]any{"range": "1h"})
	if early.Status != query.ExportQueued || early.TotalRows != nil || early.DownloadURL != nil || early.RowLimit != query.MaxExportRows {
		t.Fatalf("new export = %+v", early)
	}
	var cancelled exportBody
	if code := do(http.MethodPost, "/api/v1/exports/"+early.ID+"/cancel", alice, nil, &cancelled); code != http.StatusOK || cancelled.Status != query.ExportCancelled {
		t.Fatalf("cancel queued = %d %+v", code, cancelled)
	}
	if code := do(http.MethodPost, "/api/v1/exports/"+early.ID+"/cancel", alice, nil, &cancelled); code != http.StatusOK || cancelled.Status != query.ExportCancelled {
		t.Fatalf("cancel again = %d %+v", code, cancelled)
	}

	runCtx, stop := context.WithCancel(ctx)
	runDone := make(chan error, 1)
	go func() { runDone <- jobClient.Run(runCtx) }()
	t.Cleanup(func() {
		stop()
		if err := <-runDone; err != nil {
			t.Error(err)
		}
	})

	// The export of every row of the last hour.
	e := create(alice, map[string]any{"range": "1h", "status": "all"})
	done := waitFor(e.ID, func(e exportBody) bool { return e.Status != query.ExportQueued && e.Status != query.ExportRunning })
	if done.Status != query.ExportCompleted || done.TotalRows == nil || *done.TotalRows != n || done.RowsWritten != n ||
		done.Progress != 1 || done.SizeBytes == 0 || done.DownloadURL == nil || done.ExpiresAt == nil || done.Error != nil {
		t.Fatalf("completed export = %+v", done)
	}
	if left := time.Until(*done.ExpiresAt); left < 23*time.Hour || left > 25*time.Hour {
		t.Fatalf("expires in %v, want 24h", left)
	}
	if left := time.Until(*done.DownloadURLExpiresAt); left <= 0 || left > 16*time.Minute {
		t.Fatalf("download link expires in %v", left)
	}

	// The link needs no session; the CSV holds the project's rows only,
	// newest first, without headers or bodies.
	resp, err := http.Get(ts.URL + *done.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/gzip" ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment;") || int64(len(raw)) != done.SizeBytes {
		t.Fatalf("download = %d %v (%d bytes)", resp.StatusCode, resp.Header, len(raw))
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"sk_live_SECRET", "SECRET_COOKIE", "hunter2", "SECRET_TOKEN", "/accounts"} {
		if bytes.Contains(plain, []byte(secret)) {
			t.Fatalf("export contains %q", secret)
		}
	}
	records, err := csv.NewReader(bytes.NewReader(plain)).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != n+1 {
		t.Fatalf("%d records, want %d rows and a header", len(records), n)
	}
	header := records[0]
	want := []string{"id", "timestamp", "app_id", "environment", "method", "path", "raw_path", "status_code", "response_time_ms",
		"request_size", "response_size", "ip_address", "consumer_id", "consumer_name", "consumer_group", "sampled", "trace_id"}
	if !slices.Equal(header, want) {
		t.Fatalf("header = %q", header)
	}
	col := func(name string) int { return slices.Index(header, name) }
	first, last := records[1], records[n]
	if first[col("raw_path")] != "/login?token=[redacted]&page=0" || first[col("consumer_name")] != `'=HYPERLINK("http://evil")` ||
		first[col("app_id")] != mine.AppID.String() || first[col("status_code")] != "200" || first[col("response_time_ms")] != "12.5" ||
		first[col("sampled")] != "true" || first[col("trace_id")] != fmt.Sprintf("%032x", 1) || first[col("id")] == "" {
		t.Fatalf("first row = %q", first)
	}
	if got, err := time.Parse(time.RFC3339Nano, first[col("timestamp")]); err != nil || !got.Equal(now) {
		t.Fatalf("first timestamp = %q (%v), want %v", first[col("timestamp")], err, now)
	}
	if last[col("raw_path")] != fmt.Sprintf("/login?token=[redacted]&page=%d", n-1) {
		t.Fatalf("last row = %q", last)
	}

	// A tampered or foreign link is refused.
	for _, bad := range []string{
		strings.Replace(*done.DownloadURL, "signature=", "signature=x", 1),
		strings.Replace(*done.DownloadURL, done.ID, early.ID, 1),
		"/api/v1/exports/" + done.ID + "/download?expires=4102444800&signature=forged",
	} {
		resp, err := http.Get(ts.URL + bad)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", bad, resp.StatusCode)
		}
	}

	// An export is its creator's: other members and outsiders see 404.
	for _, u := range []uuid.UUID{bob, outsider} {
		if code := do(http.MethodGet, "/api/v1/exports/"+done.ID, u, nil, nil); code != http.StatusNotFound {
			t.Errorf("get as %v: %d, want 404", u, code)
		}
		if code := do(http.MethodPost, "/api/v1/exports/"+done.ID+"/cancel", u, nil, nil); code != http.StatusNotFound {
			t.Errorf("cancel as %v: %d, want 404", u, code)
		}
	}
	if code := do(http.MethodPost, exports, outsider, map[string]any{}, nil); code != http.StatusNotFound {
		t.Errorf("create as outsider: %d, want 404", code)
	}
	if code := do(http.MethodGet, "/api/v1/exports/"+done.ID, uuid.Nil, nil, nil); code != http.StatusUnauthorized {
		t.Errorf("get without session: %d, want 401", code)
	}
	if code := do(http.MethodPost, "/api/v1/exports/"+done.ID+"/cancel", alice, nil, nil); code != http.StatusConflict {
		t.Errorf("cancel completed: %d, want 409", code)
	}
	for _, bad := range []map[string]any{{"status": "6xx"}, {"range": "1y"}, {"method": "G T"}} {
		if code := do(http.MethodPost, exports, alice, bad, nil); code != http.StatusUnprocessableEntity {
			t.Errorf("create %v: %d, want 422", bad, code)
		}
	}

	// The early export stayed cancelled without a file.
	if e := get(early.ID); e.Status != query.ExportCancelled || e.DownloadURL != nil || e.RowsWritten != 0 {
		t.Fatalf("early export = %+v", e)
	}

	// A filtered export writes only the matching rows.
	small := create(alice, map[string]any{"range": "1h", "consumer_id": "c-3", "latency_max": 20})
	smallDone := waitFor(small.ID, func(e exportBody) bool { return e.Status == query.ExportCompleted || e.Status == query.ExportFailed })
	if smallDone.Status != query.ExportCompleted || *smallDone.TotalRows != 1429 || smallDone.RowsWritten != 1429 ||
		smallDone.Filter["consumer_id"] != "c-3" {
		t.Fatalf("filtered export = %+v", smallDone)
	}

	// Cancelling while the job runs leaves the export cancelled and no file.
	hooked.setBeforeWrite(func(key string) {
		id := strings.TrimSuffix(key, ".csv.gz")
		if code := do(http.MethodPost, "/api/v1/exports/"+id+"/cancel", alice, nil, nil); code != http.StatusOK {
			t.Errorf("cancel running: %d", code)
		}
	})
	running := create(alice, map[string]any{"range": "1h"})
	stopped := waitFor(running.ID, func(e exportBody) bool { return e.Status != query.ExportQueued && e.Status != query.ExportRunning })
	hooked.setBeforeWrite(nil)
	if stopped.Status != query.ExportCancelled || stopped.DownloadURL != nil {
		t.Fatalf("cancelled running export = %+v", stopped)
	}
	time.Sleep(500 * time.Millisecond) // let the job finish removing its file
	if _, _, err := store.Open(ctx, running.ID+".csv.gz"); err == nil {
		t.Fatal("a cancelled export kept its file")
	}

	// Past its expiry an export shows expired, its link stops working and
	// the cleanup job removes the file.
	if _, err := pool.Exec(ctx, `UPDATE request_exports SET expires_at = now() - interval '1 minute' WHERE id = $1`, done.ID); err != nil {
		t.Fatal(err)
	}
	if e := get(done.ID); e.Status != query.ExportExpired || e.DownloadURL != nil {
		t.Fatalf("expired export = %+v", e)
	}
	resp, err = http.Get(ts.URL + *done.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("download after expiry: %d, want 410", resp.StatusCode)
	}
	cleanup := query.NewExportCleanupWorker(pool, store, logger)
	if err := cleanup.Work(ctx, &river.Job[query.ExportCleanupArgs]{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Open(ctx, done.ID+".csv.gz"); err == nil {
		t.Fatal("the cleanup job kept an expired file")
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM request_exports WHERE id = $1`, done.ID).Scan(&status); err != nil || status != query.ExportExpired {
		t.Fatalf("status after cleanup = %q (%v)", status, err)
	}
	if _, _, err := store.Open(ctx, smallDone.ID+".csv.gz"); err != nil {
		t.Fatalf("the cleanup job removed a live export: %v", err)
	}
}
