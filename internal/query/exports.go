package query

import (
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Request log exports: the filtered request log as a gzip-compressed CSV of
// at most MaxExportRows rows, newest first.
//
// POST /projects/{project}/exports records the export (request_exports) and
// enqueues an ExportArgs job in the same transaction. The job streams the
// rows from ClickHouse into the ExportStore, reporting progress as it goes,
// and stops when the export is cancelled. GET /exports/{id} reports status,
// progress and, once completed, a download URL signed with the export's own
// key that stays valid for exportURLTTL (never past the export's expiry).
// Exports expire ExportTTL after they complete; ExportCleanupArgs removes
// their files.
//
// The CSV carries the request log columns only, never headers, bodies or
// query parameter values beyond the raw path, which ingest already redacted:
// the "[redacted]" markers are written as stored.
//
// An export belongs to the user who asked for it, who must still be able to
// view the project to read, cancel or link to it.

// Paths of the export operations.
const (
	ExportsPath        = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/exports"
	ExportPath         = server.APIPrefix + "/exports/{id}"
	ExportCancelPath   = ExportPath + "/cancel"
	ExportDownloadPath = ExportPath + "/download"
)

// Limits and timing of exports.
const (
	// MaxExportRows caps the rows of one export.
	MaxExportRows = 1_000_000
	// ExportTTL is how long a completed export can be downloaded.
	ExportTTL = 24 * time.Hour
	// ExportQueue is the River queue export jobs run on, so a few long
	// exports never hold every default worker.
	ExportQueue = "exports"
	// ExportQueueWorkers bounds the exports running at once per process.
	ExportQueueWorkers = 2
	// ExportCleanupInterval is how often expired export files are removed.
	ExportCleanupInterval = time.Hour

	exportURLTTL           = 15 * time.Minute
	exportJobTimeout       = 30 * time.Minute
	exportMaxAttempts      = 3
	exportProgressEvery    = 1000 // rows between progress checks
	exportProgressInterval = time.Second
	exportCleanupBatch     = 500
)

// Export statuses.
const (
	ExportQueued    = "queued"
	ExportRunning   = "running"
	ExportCompleted = "completed"
	ExportFailed    = "failed"
	ExportCancelled = "cancelled"
	ExportExpired   = "expired"
)

// exportColumns is the CSV header; exportRecord writes the fields in this
// order.
var exportColumns = []string{
	"id", "timestamp", "app_id", "environment", "method", "path", "raw_path", "status_code", "response_time_ms",
	"request_size", "response_size", "ip_address", "consumer_id", "consumer_name", "consumer_group", "sampled", "trace_id",
}

// ExportStore keeps export files. LocalExportStore keeps them on local disk
// (single-VM installs); an object store can implement the same interface.
type ExportStore interface {
	// Write stores what fill writes under key, replacing any file of that
	// key, and returns its size. When fill fails nothing is kept.
	Write(ctx context.Context, key string, fill func(io.Writer) error) (int64, error)
	// Open returns the file of key and its size.
	Open(ctx context.Context, key string) (io.ReadCloser, int64, error)
	// Remove deletes the file of key; a missing file is not an error.
	Remove(ctx context.Context, key string) error
}

// ExportPool is the Postgres access exports need; *pgxpool.Pool satisfies
// it.
type ExportPool interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// ExportJobs enqueues export jobs; *jobs.Client satisfies it.
type ExportJobs interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

type exportDeps struct {
	pool  ExportPool
	jobs  ExportJobs
	store ExportStore
}

// WithExports enables the export operations; without it they answer 503.
func (s *Service) WithExports(pool ExportPool, jobs ExportJobs, store ExportStore) *Service {
	s.exports = &exportDeps{pool: pool, jobs: jobs, store: store}
	return s
}

// ExportFilter is the request log filter of an export; the fields mean what
// the query parameters of GET /api/v1/requests mean.
type ExportFilter struct {
	Range           string   `json:"range,omitempty" enum:"1h,6h,24h,7d" doc:"Time range ending when the export is asked for; omitted means 24h."`
	Env             string   `json:"env,omitempty" maxLength:"64" doc:"Environment name; empty means all."`
	ConsumerID      string   `json:"consumer_id,omitempty" maxLength:"256" doc:"Only requests from this consumer id."`
	ConsumerGroup   string   `json:"consumer_group,omitempty" maxLength:"256" doc:"Only requests from consumers of this group."`
	IP              string   `json:"ip,omitempty" maxLength:"64" doc:"Only requests from this client IP address (exact match)."`
	Method          string   `json:"method,omitempty" pattern:"^[A-Za-z]{1,16}$" doc:"Only requests with this HTTP method (case-insensitive)."`
	Path            string   `json:"path,omitempty" maxLength:"1024" doc:"Route template, e.g. /orders/{id}."`
	URLContains     string   `json:"url_contains,omitempty" maxLength:"1024" doc:"Only requests whose raw URL path (with query string) contains this text, ignoring case."`
	PayloadContains string   `json:"payload_contains,omitempty" maxLength:"1024" doc:"Only requests whose request or response body contains this text, ignoring case. The bodies themselves are never exported."`
	RequestSizeMin  uint64   `json:"request_size_min,omitempty" doc:"Only requests with a request body of at least this many bytes."`
	RequestSizeMax  *uint64  `json:"request_size_max,omitempty" doc:"Only requests with a request body of at most this many bytes."`
	ResponseSizeMin uint64   `json:"response_size_min,omitempty" doc:"Only requests with a response body of at least this many bytes."`
	ResponseSizeMax *uint64  `json:"response_size_max,omitempty" doc:"Only requests with a response body of at most this many bytes."`
	Status          string   `json:"status,omitempty" maxLength:"256" doc:"Comma-separated status codes (404), classes (4xx) and inclusive ranges (500-503); omitted or all means every status."`
	LatencyMin      float64  `json:"latency_min,omitempty" minimum:"0" doc:"Only requests that took at least this many milliseconds."`
	LatencyMax      *float64 `json:"latency_max,omitempty" minimum:"0" doc:"Only requests that took at most this many milliseconds."`
	Sampled         string   `json:"sampled,omitempty" enum:"true,false" doc:"Only requests the SDK kept in full (true) or sampled out to a base record (false); omitted means both."`
	TraceID         string   `json:"trace_id,omitempty" maxLength:"64" doc:"Only requests of this trace."`
}

// input is the request log input f means.
func (f ExportFilter) input() *requestsInput {
	in := &requestsInput{
		ConsumerID: f.ConsumerID, ConsumerGroup: f.ConsumerGroup, IP: f.IP, Method: f.Method, Path: f.Path,
		URLContains: f.URLContains, PayloadContains: f.PayloadContains,
		RequestSizeMin: f.RequestSizeMin, ResponseSizeMin: f.ResponseSizeMin, LatencyMin: f.LatencyMin,
		Status: f.Status, Sampled: f.Sampled, TraceID: f.TraceID,
	}
	in.Range, in.Env = f.Range, f.Env
	if f.RequestSizeMax != nil {
		in.RequestSizeMax, in.hasRequestSizeMax = *f.RequestSizeMax, true
	}
	if f.ResponseSizeMax != nil {
		in.ResponseSizeMax, in.hasResponseSizeMax = *f.ResponseSizeMax, true
	}
	if f.LatencyMax != nil {
		in.LatencyMax, in.hasLatencyMax = *f.LatencyMax, true
	}
	return in
}

// RequestExport is an export of the request log.
type RequestExport struct {
	ID                   string       `json:"id" format:"uuid" doc:"The export's id."`
	Status               string       `json:"status" enum:"queued,running,completed,failed,cancelled,expired" doc:"queued until a worker starts it; completed exports expire 24 hours after they finish."`
	Filter               ExportFilter `json:"filter" doc:"The filter the export was asked with."`
	From                 time.Time    `json:"from" doc:"Start of the exported time range (inclusive)."`
	To                   time.Time    `json:"to" doc:"End of the exported time range (exclusive)."`
	RowLimit             int64        `json:"row_limit" doc:"The most rows the export writes, newest first."`
	TotalRows            *int64       `json:"total_rows" required:"true" nullable:"true" doc:"Rows the export writes, capped at row_limit; null until it starts."`
	RowsWritten          int64        `json:"rows_written" doc:"Rows written so far."`
	Progress             float64      `json:"progress" doc:"rows_written / total_rows, from 0 to 1; 1 once completed."`
	SizeBytes            int64        `json:"size_bytes" doc:"Size of the gzip-compressed CSV once completed."`
	Error                *string      `json:"error" required:"true" nullable:"true" doc:"Why a failed export failed."`
	CreatedAt            time.Time    `json:"created_at" doc:"When the export was asked for."`
	StartedAt            *time.Time   `json:"started_at" required:"true" nullable:"true" doc:"When a worker started writing it; null while queued."`
	FinishedAt           *time.Time   `json:"finished_at" required:"true" nullable:"true" doc:"When it completed, failed or was cancelled; null before."`
	ExpiresAt            *time.Time   `json:"expires_at" required:"true" nullable:"true" doc:"When a completed export stops being downloadable."`
	DownloadURL          *string      `json:"download_url" required:"true" nullable:"true" doc:"Signed URL of the gzip-compressed CSV, relative to the API origin, while completed; it needs no Authorization header. Fetch this export again for a fresh one once it expires."`
	DownloadURLExpiresAt *time.Time   `json:"download_url_expires_at" required:"true" nullable:"true" doc:"When download_url stops working."`
}

type exportOutput struct {
	Body RequestExport
}

type createExportInput struct {
	Project string       `path:"project" maxLength:"63" doc:"Project slug."`
	Body    ExportFilter `doc:"The request log filter; {} exports the last 24 hours."`
}

type exportInput struct {
	ID string `path:"id" format:"uuid" doc:"The export's id."`
}

type exportDownloadInput struct {
	ID        string `path:"id" format:"uuid" doc:"The export's id."`
	Expires   int64  `query:"expires" doc:"Expiry of the link, Unix seconds, as download_url carries it."`
	Signature string `query:"signature" maxLength:"128" doc:"Signature of the link, as download_url carries it."`
}

func registerExports(api huma.API, s *Service, guard *authz.Guard) {
	session := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "create-request-export",
		Method:      http.MethodPost,
		Path:        ExportsPath,
		Summary:     "Export the request log as CSV",
		Description: "Starts an export of the filtered request log: at most 1,000,000 rows, newest first, written as a gzip-compressed CSV by a background job. " +
			"Poll GET /api/v1/exports/{id} for progress and the download link. Headers and bodies are never exported. Needs a user session that can view the project.",
		Tags:          []string{server.TagProjects},
		Security:      session,
		Middlewares:   huma.Middlewares{guard.RequireProject(api, authz.ProjectView)},
		DefaultStatus: http.StatusAccepted,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable), s.createExport)
	huma.Register(api, huma.Operation{
		OperationID: "get-request-export",
		Method:      http.MethodGet,
		Path:        ExportPath,
		Summary:     "Get a request log export",
		Description: "Status, progress and, once completed, a signed download URL of one of the caller's exports. Another user's export answers 404.",
		Tags:        []string{server.TagProjects},
		Security:    session,
	}, func(ctx context.Context, in *exportInput) (*exportOutput, error) {
		row, err := s.ownExport(ctx, guard, in.ID)
		if err != nil {
			return nil, err
		}
		return &exportOutput{Body: toRequestExport(row, s.now())}, nil
	})
	huma.Register(api, huma.Operation{
		OperationID: "cancel-request-export",
		Method:      http.MethodPost,
		Path:        ExportCancelPath,
		Summary:     "Cancel a request log export",
		Description: "Cancels one of the caller's queued or running exports; a running job stops within a second and keeps no file. Cancelling a cancelled export is a no-op; a finished one answers 409.",
		Tags:        []string{server.TagProjects},
		Security:    session,
	}, func(ctx context.Context, in *exportInput) (*exportOutput, error) {
		return s.cancelExport(ctx, guard, in)
	})
	huma.Register(api, huma.Operation{
		OperationID: "download-request-export",
		Method:      http.MethodGet,
		Path:        ExportDownloadPath,
		Summary:     "Download a request log export",
		Description: "The gzip-compressed CSV of a completed export. Authorized by the link's signature (download_url of GET /api/v1/exports/{id}), not by a session: " +
			"403 for a bad or expired link, 410 once the export expired.",
		Tags: []string{server.TagProjects},
		Responses: map[string]*huma.Response{
			"200": {
				Description: "The export as a gzip-compressed CSV.",
				Content:     map[string]*huma.MediaType{"application/gzip": {Schema: &huma.Schema{Type: huma.TypeString, Format: "binary"}}},
			},
		},
	}, s.downloadExport)
}

func (s *Service) exportDeps() (*exportDeps, error) {
	if s.exports == nil {
		return nil, huma.Error503ServiceUnavailable("exports unavailable")
	}
	return s.exports, nil
}

func (s *Service) createExport(ctx context.Context, in *createExportInput) (*exportOutput, error) {
	t, p, err := viewUser(ctx)
	if err != nil {
		return nil, err
	}
	deps, err := s.exportDeps()
	if err != nil {
		return nil, err
	}
	f := in.Body
	if f.Range == "" {
		f.Range = "24h"
	}
	if strings.EqualFold(strings.TrimSpace(f.Status), "all") {
		f.Status = ""
	}
	w, err := resolveWindow(f.Range, s.now())
	if err != nil {
		return nil, err
	}
	if _, _, err := requestFilter(f.input(), nil, nil); err != nil {
		return nil, err
	}
	filter, err := json.Marshal(f)
	if err != nil {
		return nil, internalError("export filter", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError("export id", err)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, internalError("export key", err)
	}
	tx, err := deps.pool.Begin(ctx)
	if err != nil {
		return nil, internalError("create export", err)
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	uid := p.UserID
	row, err := db.New(tx).CreateRequestExport(ctx, db.CreateRequestExportParams{
		ID: id, ProjectID: t.ProjectID, CreatedBy: &uid, Filter: filter,
		RangeFrom: w.from, RangeTo: w.to, RowLimit: MaxExportRows, SigningKey: key,
	})
	if err != nil {
		return nil, internalError("create export", err)
	}
	if _, err := deps.jobs.InsertTx(ctx, tx, ExportArgs{ID: id}, nil); err != nil {
		return nil, internalError("enqueue export", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, internalError("create export", err)
	}
	return &exportOutput{Body: toRequestExport(row, s.now())}, nil
}

// ownExport loads an export of the session's user on a project they can
// still view. Anything else answers 404.
func (s *Service) ownExport(ctx context.Context, projects ProjectAuthorizer, rawID string) (db.RequestExport, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return db.RequestExport{}, huma.Error401Unauthorized("a user session is required")
	}
	deps, err := s.exportDeps()
	if err != nil {
		return db.RequestExport{}, err
	}
	notFound := huma.Error404NotFound("export not found")
	id, err := uuid.Parse(rawID)
	if err != nil {
		return db.RequestExport{}, notFound
	}
	row, err := db.New(deps.pool).GetRequestExport(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.RequestExport{}, notFound
	}
	if err != nil {
		return db.RequestExport{}, internalError("export lookup", err)
	}
	if row.CreatedBy == nil || *row.CreatedBy != p.UserID {
		return db.RequestExport{}, notFound
	}
	project, err := s.catalog.GetProjectWithOrg(ctx, row.ProjectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.RequestExport{}, notFound
	}
	if err != nil {
		return db.RequestExport{}, internalError("project lookup", err)
	}
	if projects == nil {
		return db.RequestExport{}, huma.Error503ServiceUnavailable("authorization backend unavailable, retry later")
	}
	t, err := projects.AuthorizeProject(ctx, p, project.Slug, authz.ProjectView)
	switch {
	case err == nil && t.ProjectID == row.ProjectID:
		return row, nil
	case err == nil, errors.Is(err, authz.ErrNoResource), errors.Is(err, authz.ErrForbidden):
		return db.RequestExport{}, notFound
	case errors.Is(err, authz.ErrUnavailable):
		return db.RequestExport{}, huma.Error503ServiceUnavailable("authorization backend unavailable, retry later")
	default:
		return db.RequestExport{}, internalError("authorization", err)
	}
}

func (s *Service) cancelExport(ctx context.Context, projects ProjectAuthorizer, in *exportInput) (*exportOutput, error) {
	cur, err := s.ownExport(ctx, projects, in.ID)
	if err != nil {
		return nil, err
	}
	row, err := db.New(s.exports.pool).CancelRequestExport(ctx, cur.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		if cur.Status == ExportCancelled {
			return &exportOutput{Body: toRequestExport(cur, s.now())}, nil
		}
		return nil, huma.Error409Conflict("the export already finished")
	}
	if err != nil {
		return nil, internalError("cancel export", err)
	}
	return &exportOutput{Body: toRequestExport(row, s.now())}, nil
}

func (s *Service) downloadExport(ctx context.Context, in *exportDownloadInput) (*huma.StreamResponse, error) {
	deps, err := s.exportDeps()
	if err != nil {
		return nil, err
	}
	bad := huma.Error403Forbidden("invalid or expired download link; get the export again for a fresh one")
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, bad
	}
	row, err := db.New(deps.pool).GetRequestExport(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, bad
	}
	if err != nil {
		return nil, internalError("export lookup", err)
	}
	now := s.now()
	if !hmac.Equal([]byte(in.Signature), []byte(exportSignature(row.SigningKey, row.ID, in.Expires))) || now.Unix() > in.Expires {
		return nil, bad
	}
	if row.Status != ExportCompleted || row.FileKey == nil || row.ExpiresAt == nil || !now.Before(*row.ExpiresAt) {
		return nil, huma.Error410Gone("the export expired")
	}
	file, size, err := deps.store.Open(ctx, *row.FileKey)
	if err != nil {
		return nil, internalError("open export", err)
	}
	name := "requests-" + row.RangeTo.UTC().Format("20060102-1504") + "-" + row.ID.String()[:8] + ".csv.gz"
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		defer func() { _ = file.Close() }()
		hctx.SetHeader("Content-Type", "application/gzip")
		hctx.SetHeader("Content-Disposition", `attachment; filename="`+name+`"`)
		hctx.SetHeader("Content-Length", strconv.FormatInt(size, 10))
		hctx.SetHeader("Cache-Control", "private, no-store")
		_, _ = io.Copy(hctx.BodyWriter(), file)
	}}, nil
}

// exportSignature signs a download link of export id valid until expires.
func exportSignature(key []byte, id uuid.UUID, expires int64) string {
	m := hmac.New(sha256.New, key)
	_, _ = fmt.Fprintf(m, "%s\n%d", id, expires)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// toRequestExport renders an export as of now: a completed export past its
// expiry shows as expired before the cleanup job marks it.
func toRequestExport(r db.RequestExport, now time.Time) RequestExport {
	out := RequestExport{
		ID: r.ID.String(), Status: r.Status, From: r.RangeFrom.UTC(), To: r.RangeTo.UTC(), RowLimit: r.RowLimit,
		TotalRows: r.TotalRows, RowsWritten: r.RowsWritten, SizeBytes: r.SizeBytes, Error: r.Error,
		CreatedAt: r.CreatedAt.UTC(), StartedAt: utcPtr(r.StartedAt), FinishedAt: utcPtr(r.FinishedAt), ExpiresAt: utcPtr(r.ExpiresAt),
	}
	_ = json.Unmarshal(r.Filter, &out.Filter)
	switch {
	case r.Status == ExportCompleted:
		out.Progress = 1
	case r.TotalRows != nil && *r.TotalRows > 0:
		out.Progress = min(1, float64(r.RowsWritten)/float64(*r.TotalRows))
	}
	if r.Status == ExportCompleted && (r.ExpiresAt == nil || !now.Before(*r.ExpiresAt)) {
		out.Status = ExportExpired
	}
	if out.Status == ExportCompleted {
		exp := now.Add(exportURLTTL)
		if r.ExpiresAt.Before(exp) {
			exp = *r.ExpiresAt
		}
		unix := exp.Unix()
		url := fmt.Sprintf("%s/exports/%s/download?expires=%d&signature=%s", server.APIPrefix, r.ID, unix, exportSignature(r.SigningKey, r.ID, unix))
		at := time.Unix(unix, 0).UTC()
		out.DownloadURL, out.DownloadURLExpiresAt = &url, &at
	}
	return out
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// ---------------------------------------------------------------- jobs

// ExportArgs is the job that writes one export.
type ExportArgs struct {
	ID uuid.UUID `json:"id"`
}

// Kind is the job kind.
func (ExportArgs) Kind() string { return "query.export" }

// InsertOpts puts exports on their own queue.
func (ExportArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: ExportQueue, MaxAttempts: exportMaxAttempts}
}

// ExportCleanupArgs is the periodic job that removes expired export files.
type ExportCleanupArgs struct{}

// Kind is the job kind.
func (ExportCleanupArgs) Kind() string { return "query.export_cleanup" }

// InsertOpts puts the cleanup on the exports queue.
func (ExportCleanupArgs) InsertOpts() river.InsertOpts { return river.InsertOpts{Queue: ExportQueue} }

// errExportCancelled stops a job whose export was cancelled.
var errExportCancelled = errors.New("export cancelled")

// ExportWorker works ExportArgs.
type ExportWorker struct {
	river.WorkerDefaults[ExportArgs]
	ch     driver.Conn
	pool   db.DBTX
	store  ExportStore
	logger *slog.Logger
	now    func() time.Time
}

// NewExportWorker returns the export worker.
func NewExportWorker(ch driver.Conn, pool db.DBTX, store ExportStore, logger *slog.Logger) *ExportWorker {
	return &ExportWorker{ch: ch, pool: pool, store: store, logger: logger, now: time.Now}
}

// Timeout leaves room for a million rows.
func (*ExportWorker) Timeout(*river.Job[ExportArgs]) time.Duration { return exportJobTimeout }

// Work writes the export. A cancelled export ends the job without a file; a
// failure is retried, and marks the export failed on the last attempt.
func (w *ExportWorker) Work(ctx context.Context, job *river.Job[ExportArgs]) error {
	q := db.New(w.pool)
	row, err := q.StartRequestExport(ctx, job.Args.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // cancelled before it started, or already done
	}
	if err != nil {
		return err
	}
	err = w.write(ctx, q, row)
	switch {
	case err == nil, errors.Is(err, errExportCancelled):
		return nil
	case job.Attempt < job.MaxAttempts:
		w.logger.WarnContext(ctx, "export failed; will retry", "export_id", row.ID, "attempt", job.Attempt, "error", err)
		return err
	}
	w.logger.ErrorContext(ctx, "export failed; giving up", "export_id", row.ID, "attempt", job.Attempt, "error", err)
	msg := "the export failed; try again"
	if _, ferr := q.FailRequestExport(context.WithoutCancel(ctx), db.FailRequestExportParams{ID: row.ID, Error: &msg}); ferr != nil {
		return errors.Join(err, ferr)
	}
	return river.JobCancel(err)
}

// exportCtx bounds the ClickHouse side of one export.
func exportCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"max_execution_time": int(exportJobTimeout.Seconds()),
	}))
	return context.WithTimeout(ctx, exportJobTimeout)
}

func (w *ExportWorker) write(ctx context.Context, q *db.Queries, row db.RequestExport) error {
	var f ExportFilter
	if err := json.Unmarshal(row.Filter, &f); err != nil {
		return fmt.Errorf("export filter: %w", err)
	}
	where, args := tenantFilter(row.ProjectID, f.Env)
	clauses, args, err := requestFilter(f.input(), []string{where, "timestamp >= ?", "timestamp < ?"}, append(args, row.RangeFrom, row.RangeTo))
	if err != nil {
		return fmt.Errorf("export filter: %w", err)
	}
	cond := strings.Join(clauses, " AND ")
	cctx, cancel := exportCtx(ctx)
	defer cancel()

	var total uint64
	if err := w.ch.QueryRow(cctx, `SELECT count() FROM api_requests WHERE `+cond, args...).Scan(&total); err != nil {
		return fmt.Errorf("count rows: %w", err)
	}
	totalRows := min(int64(total), row.RowLimit) //nolint:gosec // a row count fits int64
	if n, err := q.SetRequestExportTotal(ctx, db.SetRequestExportTotalParams{ID: row.ID, TotalRows: &totalRows}); err != nil {
		return err
	} else if n == 0 {
		return errExportCancelled
	}

	key := row.ID.String() + ".csv.gz"
	var written int64
	size, err := w.store.Write(ctx, key, func(out io.Writer) error {
		gz := gzip.NewWriter(out)
		cw := csv.NewWriter(gz)
		if err := cw.Write(exportColumns); err != nil {
			return err
		}
		rows, err := w.ch.Query(cctx, `
			SELECT timestamp, app_id, environment, method, path, raw_path, status_code, response_time_ms,
			       request_size, response_size, ip_address, consumer_id, consumer_name, consumer_group, sampled, trace_id, span_id
			FROM api_requests WHERE `+cond+`
			ORDER BY timestamp DESC, trace_id DESC LIMIT ?`, append(args, row.RowLimit)...)
		if err != nil {
			return fmt.Errorf("query rows: %w", err)
		}
		defer func() { _ = rows.Close() }()
		last := w.now()
		record := make([]string, len(exportColumns))
		for rows.Next() {
			var (
				r       requestRow
				app     uuid.UUID
				sampled uint8
				span    string
			)
			if err := rows.Scan(&r.Timestamp, &app, &r.Environment, &r.Method, &r.Path, &r.RawPath, &r.StatusCode, &r.ResponseTimeMs,
				&r.RequestSize, &r.ResponseSize, &r.IPAddress, &r.ConsumerID, &r.ConsumerName, &r.ConsumerGroup, &sampled, &r.TraceID, &span); err != nil {
				return fmt.Errorf("scan row: %w", err)
			}
			r.ID = requestID{ms: r.Timestamp.UnixMilli(), traceID: r.TraceID, spanID: span}.encode()
			r.AppID, r.Sampled = app.String(), sampled != 0
			if err := cw.Write(exportRecord(record, r)); err != nil {
				return err
			}
			written++
			if written%exportProgressEvery == 0 && w.now().Sub(last) >= exportProgressInterval {
				last = w.now()
				n, err := q.SetRequestExportProgress(ctx, db.SetRequestExportProgressParams{ID: row.ID, RowsWritten: written})
				if err != nil {
					return err
				}
				if n == 0 {
					return errExportCancelled
				}
			}
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read rows: %w", err)
		}
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
		return gz.Close()
	})
	if err != nil {
		return err
	}
	expires := w.now().Add(ExportTTL)
	n, err := q.CompleteRequestExport(ctx, db.CompleteRequestExportParams{
		ID: row.ID, RowsWritten: written, SizeBytes: size, FileKey: &key, ExpiresAt: &expires,
	})
	if err == nil && n == 0 {
		err = errExportCancelled // cancelled while the file was finished
	}
	if err != nil {
		if rerr := w.store.Remove(context.WithoutCancel(ctx), key); rerr != nil {
			w.logger.WarnContext(ctx, "remove export file", "export_id", row.ID, "error", rerr)
		}
		return err
	}
	w.logger.InfoContext(ctx, "export completed", "export_id", row.ID, "rows", written, "bytes", size)
	return nil
}

// exportRecord fills record with r in exportColumns order.
func exportRecord(record []string, r requestRow) []string {
	record[0] = r.ID
	record[1] = r.Timestamp.UTC().Format(time.RFC3339Nano)
	record[2] = r.AppID
	record[3] = csvText(r.Environment)
	record[4] = csvText(r.Method)
	record[5] = csvText(r.Path)
	record[6] = csvText(r.RawPath)
	record[7] = strconv.FormatUint(uint64(r.StatusCode), 10)
	record[8] = strconv.FormatFloat(r.ResponseTimeMs, 'f', -1, 64)
	record[9] = strconv.FormatUint(r.RequestSize, 10)
	record[10] = strconv.FormatUint(r.ResponseSize, 10)
	record[11] = csvText(r.IPAddress)
	record[12] = csvText(r.ConsumerID)
	record[13] = csvText(r.ConsumerName)
	record[14] = csvText(r.ConsumerGroup)
	record[15] = strconv.FormatBool(r.Sampled)
	record[16] = csvText(r.TraceID)
	return record
}

// csvText guards a text cell against spreadsheet formula injection: a cell
// starting with =, +, -, @, tab or carriage return gets a leading quote, as
// OWASP recommends. Everything else, redaction markers included, is written
// as stored.
func csvText(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

// ExportCleanupWorker works ExportCleanupArgs.
type ExportCleanupWorker struct {
	river.WorkerDefaults[ExportCleanupArgs]
	pool   db.DBTX
	store  ExportStore
	logger *slog.Logger
	now    func() time.Time
}

// NewExportCleanupWorker returns the cleanup worker.
func NewExportCleanupWorker(pool db.DBTX, store ExportStore, logger *slog.Logger) *ExportCleanupWorker {
	return &ExportCleanupWorker{pool: pool, store: store, logger: logger, now: time.Now}
}

// Work removes the files of expired exports and marks them expired.
func (w *ExportCleanupWorker) Work(ctx context.Context, _ *river.Job[ExportCleanupArgs]) error {
	q := db.New(w.pool)
	for {
		rows, err := q.ListExpiredRequestExports(ctx, db.ListExpiredRequestExportsParams{Now: w.now(), MaxRows: exportCleanupBatch})
		if err != nil {
			return err
		}
		for _, r := range rows {
			if r.FileKey != nil {
				if err := w.store.Remove(ctx, *r.FileKey); err != nil {
					return fmt.Errorf("remove export %s: %w", r.ID, err)
				}
			}
			if _, err := q.ExpireRequestExport(ctx, r.ID); err != nil {
				return err
			}
		}
		if len(rows) > 0 {
			w.logger.InfoContext(ctx, "expired exports removed", "exports", len(rows))
		}
		if len(rows) < exportCleanupBatch {
			return nil
		}
	}
}
