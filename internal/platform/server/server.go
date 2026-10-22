// Package server is the HTTP server shared by every role in a process.
//
// Roles register plain handlers on Mux() (the ingest hot path) or typed
// operations on API() (Huma, which also produces the OpenAPI 3.1 spec).
// Health endpoints and Prometheus metrics are always mounted:
//
//	GET /livez    process is up
//	GET /readyz   all registered readiness checks pass and we are not draining
//	GET /metrics  Prometheus exposition
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/apilens/apilens/internal/platform/buildinfo"
	"github.com/apilens/apilens/internal/platform/config"
)

// APIPrefix is the mount point of the Huma (dashboard/public) API.
const APIPrefix = "/api/v1"

// Check reports whether a dependency is usable. It must respect ctx.
type Check func(ctx context.Context) error

// Server owns the mux, the Huma API and the readiness checks.
type Server struct {
	cfg      config.ServerConfig
	logger   *slog.Logger
	mux      *http.ServeMux
	api      huma.API
	registry *prometheus.Registry
	wrap     func(http.Handler) http.Handler

	mu       sync.RWMutex
	checks   map[string]Check
	draining atomic.Bool

	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

// New builds a Server. registry receives HTTP metrics and is exposed on
// /metrics.
func New(cfg config.ServerConfig, logger *slog.Logger, registry *prometheus.Registry) *Server {
	mux := http.NewServeMux()
	s := &Server{
		cfg:      cfg,
		logger:   logger,
		mux:      mux,
		registry: registry,
		checks:   map[string]Check{},
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_http_requests_total",
			Help: "HTTP requests by route pattern and status code.",
		}, []string{"route", "code"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "apilens_http_request_duration_seconds",
			Help:    "HTTP request latency by route pattern.",
			Buckets: []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
		}, []string{"route"}),
	}
	registry.MustRegister(s.requests, s.duration)

	s.api = humago.New(mux, NewAPIConfig())

	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{Registry: registry}))
	return s
}

// NewAPIConfig is the Huma configuration shared by the server and the
// `apilens openapi` command, so the committed spec matches what is served.
func NewAPIConfig() huma.Config {
	cfg := huma.DefaultConfig("APILens API", buildinfo.Get().Version)
	cfg.Info.Description = "Dashboard and management API for APILens. Ingest endpoints (/v1/*, /otlp/v1/*) are documented separately."
	cfg.Info.License = &huma.License{Name: "MIT", Identifier: "MIT"}
	cfg.OpenAPIPath = APIPrefix + "/openapi"
	cfg.SchemasPath = APIPrefix + "/schemas"
	// No bundled docs UI: it loads assets from a CDN, which self-hosted
	// installs may not allow.
	cfg.DocsPath = ""
	return cfg
}

// Mux returns the underlying mux for plain handlers.
func (s *Server) Mux() *http.ServeMux { return s.mux }

// API returns the Huma API for typed operations.
func (s *Server) API() huma.API { return s.api }

// SetWrapper installs an outer handler wrapper (for example OpenTelemetry).
func (s *Server) SetWrapper(wrap func(http.Handler) http.Handler) { s.wrap = wrap }

// AddReadinessCheck registers a dependency check for /readyz.
func (s *Server) AddReadinessCheck(name string, c Check) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checks[name] = c
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "draining"})
		return
	}
	s.mu.RLock()
	names := make([]string, 0, len(s.checks))
	for n := range s.checks {
		names = append(names, n)
	}
	checks := make(map[string]Check, len(s.checks))
	for n, c := range s.checks {
		checks[n] = c
	}
	s.mu.RUnlock()
	sort.Strings(names)

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		failed = map[string]string{}
	)
	for _, n := range names {
		wg.Add(1)
		go func(n string) {
			defer wg.Done()
			if err := checks[n](ctx); err != nil {
				mu.Lock()
				failed[n] = err.Error()
				mu.Unlock()
			}
		}(n)
	}
	wg.Wait()
	if len(failed) > 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unavailable", "failed": failed})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "checks": names})
}

// Handler returns the full handler chain (metrics, panic recovery, wrapper).
func (s *Server) Handler() http.Handler {
	var h http.Handler = s.mux
	h = s.instrument(h)
	h = recoverer(s.logger, h)
	if s.wrap != nil {
		h = s.wrap(h)
	}
	return h
}

// Run listens until ctx is cancelled, then drains in-flight requests.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.cfg.Addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: s.cfg.ReadHeaderTimeout,
		ReadTimeout:       s.cfg.ReadTimeout,
		WriteTimeout:      s.cfg.WriteTimeout,
		IdleTimeout:       s.cfg.IdleTimeout,
		ErrorLog:          slog.NewLogLogger(s.logger.Handler(), slog.LevelWarn),
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", s.cfg.Addr)
	if err != nil {
		return fmt.Errorf("server: listen %s: %w", s.cfg.Addr, err)
	}
	s.logger.Info("http server listening", "addr", ln.Addr().String())

	var admin *http.Server
	if s.cfg.AdminAddr != "" {
		admin = adminServer(s.cfg.AdminAddr)
		go func() {
			if err := admin.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				s.logger.Error("admin server failed", "error", err)
			}
		}()
	}

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}

	s.draining.Store(true)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
	defer cancel()
	if admin != nil {
		_ = admin.Shutdown(shutdownCtx)
	}
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("server: shutdown: %w", err)
	}
	s.logger.Info("http server stopped")
	return nil
}

func adminServer(addr string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (s *Server) instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		route := r.Pattern // set by ServeMux on the shared *Request
		if route == "" {
			route = "unmatched"
		}
		s.requests.WithLabelValues(route, strconv.Itoa(rec.status)).Inc()
		s.duration.WithLabelValues(route).Observe(time.Since(start).Seconds())
	})
}

func recoverer(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(v)
				}
				logger.Error("panic in handler", "panic", v, "path", r.URL.Path)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal_error", "detail": "Something went wrong"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
