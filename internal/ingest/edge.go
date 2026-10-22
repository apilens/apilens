// Package ingest is the edge role: it authenticates SDK and OpenTelemetry
// traffic, validates and normalises records, and hands rows to the sink.
// Nothing on this path calls another APILens service per request: API keys
// and apps are resolved from in-process caches.
package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/gzip"
	"github.com/klauspost/compress/zstd"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/config"
)

// Scope required on API keys used for ingestion.
const Scope = "ingest"

// Verifier resolves API keys.
type Verifier interface {
	Verify(ctx context.Context, raw string) (apikeys.Principal, error)
}

// AppResolver maps SDK app identifiers (UUID or slug) to app IDs.
type AppResolver interface {
	Resolve(ctx context.Context, projectID uuid.UUID, identifiers []string) (map[string]uuid.UUID, error)
}

// Edge serves the ingest endpoints.
type Edge struct {
	verifier Verifier
	apps     AppResolver
	sink     pipeline.Sink
	cfg      config.IngestConfig
	logger   *slog.Logger
	now      func() time.Time

	records *prometheus.CounterVec
	batches *prometheus.CounterVec
}

// New builds the edge. reg may be nil.
func New(verifier Verifier, apps AppResolver, sink pipeline.Sink, cfg config.IngestConfig, logger *slog.Logger, reg prometheus.Registerer) *Edge {
	e := &Edge{
		verifier: verifier, apps: apps, sink: sink, cfg: cfg, logger: logger, now: time.Now,
		records: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_ingest_records_total", Help: "Ingested records by signal and result.",
		}, []string{"signal", "result"}),
		batches: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_ingest_batches_total", Help: "Ingest calls by signal and HTTP status.",
		}, []string{"signal", "code"}),
	}
	if reg != nil {
		reg.MustRegister(e.records, e.batches)
	}
	return e
}

// Register mounts the ingest routes.
func (e *Edge) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "healthy", "service": "apilens-ingest"})
	})
	mux.HandleFunc("POST /v1/requests", e.handleRequests)
	mux.HandleFunc("POST /v1/logs", e.handleLogs)
	mux.HandleFunc("POST /v1/traces", e.handleSpans)
	mux.HandleFunc("POST /v1/deploys", e.handleDeploys)
	mux.HandleFunc("POST /otlp/v1/traces", e.handleOTLPTraces)
	mux.HandleFunc("POST /otlp/v1/logs", e.handleOTLPLogs)
}

// apiError is the v1-compatible error body: {"error": code, "detail": ...}.
type apiError struct {
	status     int
	Code       string `json:"error"`
	Detail     any    `json:"detail"`
	retryAfter time.Duration
}

func (e *apiError) Error() string { return fmt.Sprintf("%d %s: %v", e.status, e.Code, e.Detail) }

func errAuth() *apiError {
	return &apiError{status: http.StatusUnauthorized, Code: "authentication_error", Detail: "Authentication required"}
}

func errValidation(format string, args ...any) *apiError {
	return &apiError{status: http.StatusUnprocessableEntity, Code: "validation_error", Detail: fmt.Sprintf(format, args...)}
}

func errUnavailable(detail string) *apiError {
	return &apiError{status: http.StatusServiceUnavailable, Code: "unavailable", Detail: detail, retryAfter: time.Second}
}

func (e *Edge) fail(w http.ResponseWriter, signal string, err *apiError) {
	if err.retryAfter > 0 {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(err.retryAfter.Seconds())))
	}
	e.batches.WithLabelValues(signal, fmt.Sprintf("%d", err.status)).Inc()
	writeJSON(w, err.status, err)
}

// authenticate accepts `X-API-Key: <key>` (SDKs) or `Authorization: Bearer
// <key>` (OTLP exporters configured with headers).
func (e *Edge) authenticate(r *http.Request) (apikeys.Principal, *apiError) {
	raw := strings.TrimSpace(r.Header.Get("X-API-Key"))
	if raw == "" {
		if auth := r.Header.Get("Authorization"); len(auth) > 7 && strings.EqualFold(auth[:7], "bearer ") {
			raw = strings.TrimSpace(auth[7:])
		}
	}
	if raw == "" {
		return apikeys.Principal{}, errAuth()
	}
	p, err := e.verifier.Verify(r.Context(), raw)
	switch {
	case errors.Is(err, apikeys.ErrInvalidKey):
		return apikeys.Principal{}, errAuth()
	case err != nil:
		e.logger.Error("api key verification unavailable", "error", err)
		return apikeys.Principal{}, errUnavailable("Authentication backend unavailable, retry later")
	case !p.HasScope(Scope):
		return apikeys.Principal{}, &apiError{status: http.StatusForbidden, Code: "permission_denied", Detail: "API key is not allowed to ingest"}
	}
	return p, nil
}

// readBody returns the decompressed request body, enforcing the size limit
// on both the wire bytes and the decompressed bytes (zip-bomb guard).
func (e *Edge) readBody(w http.ResponseWriter, r *http.Request) ([]byte, *apiError) {
	limit := e.cfg.MaxBodyBytes
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	var reader io.Reader = r.Body
	switch enc := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))); enc {
	case "", "identity":
	case "gzip":
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, &apiError{status: http.StatusBadRequest, Code: "invalid_body", Detail: "invalid gzip body"}
		}
		defer func() { _ = gz.Close() }()
		reader = gz
	case "zstd":
		zr, err := zstd.NewReader(r.Body, zstd.WithDecoderMaxMemory(uint64(limit)) /* #nosec G115 -- limit validated > 0 */, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return nil, &apiError{status: http.StatusBadRequest, Code: "invalid_body", Detail: "invalid zstd body"}
		}
		defer zr.Close()
		reader = zr
	default:
		return nil, &apiError{status: http.StatusUnsupportedMediaType, Code: "unsupported_encoding", Detail: "Content-Encoding must be gzip, zstd or identity"}
	}
	body, err := io.ReadAll(io.LimitReader(reader, limit+1))
	var maxErr *http.MaxBytesError
	switch {
	case errors.As(err, &maxErr) || int64(len(body)) > limit:
		return nil, &apiError{status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Detail: fmt.Sprintf("body exceeds %d bytes", limit)}
	case err != nil:
		return nil, &apiError{status: http.StatusBadRequest, Code: "invalid_body", Detail: "could not read body"}
	}
	return body, nil
}

func mediaType(r *http.Request) string {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return ""
	}
	return mt
}

// decodeJSON parses a v1 JSON body.
func (e *Edge) decodeJSON(w http.ResponseWriter, r *http.Request, v any) *apiError {
	if mt := mediaType(r); mt != "" && mt != "application/json" {
		return &apiError{status: http.StatusUnsupportedMediaType, Code: "unsupported_media_type", Detail: "Content-Type must be application/json"}
	}
	body, aerr := e.readBody(w, r)
	if aerr != nil {
		return aerr
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(v); err != nil {
		return errValidation("invalid JSON: %v", err)
	}
	return nil
}

// submitError maps sink errors to retryable HTTP responses.
func (e *Edge) submitError(err error) *apiError {
	switch {
	case errors.Is(err, pipeline.ErrOverloaded):
		return errUnavailable("Ingest is overloaded, retry later")
	case errors.Is(err, pipeline.ErrClosed):
		return errUnavailable("Ingest is shutting down, retry later")
	default:
		e.logger.Error("sink rejected batch", "error", err)
		return errUnavailable("Could not store records, retry later")
	}
}

// resolveApps validates project_slug and maps app identifiers. allowEmpty
// lets deploys omit app_id (project-wide).
func (e *Edge) resolveApps(ctx context.Context, p apikeys.Principal, slugs, idents []string, allowEmpty bool) (map[string]uuid.UUID, *apiError) {
	for _, s := range slugs {
		if s = strings.TrimSpace(s); s != "" && s != p.ProjectSlug {
			return nil, errValidation("project_slug must match the API key project '%s'", p.ProjectSlug)
		}
	}
	var lookup []string
	for _, id := range idents {
		id = strings.TrimSpace(id)
		if id == "" {
			if allowEmpty {
				continue
			}
			return nil, errValidation("app_id is required for every record")
		}
		lookup = append(lookup, id)
	}
	if len(lookup) == 0 {
		return map[string]uuid.UUID{}, nil
	}
	m, err := e.apps.Resolve(ctx, p.ProjectID, lookup)
	var unknown *catalog.UnknownAppsError
	switch {
	case errors.As(err, &unknown):
		return nil, errValidation("Invalid app identifiers: %s", strings.Join(unknown.Identifiers, ", "))
	case err != nil:
		e.logger.Error("app resolution unavailable", "error", err)
		return nil, errUnavailable("Catalog unavailable, retry later")
	}
	return m, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
