package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/platform/config"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	return New(config.ServerConfig{Addr: ":0"}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
}

func TestHealthEndpoints(t *testing.T) {
	s := newTestServer(t)
	s.AddReadinessCheck("ok", func(context.Context) error { return nil })
	h := s.Handler()

	for _, path := range []string{"/livez", "/readyz", "/metrics"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s = %d", path, rec.Code)
		}
	}

	s.AddReadinessCheck("db", func(context.Context) error { return errors.New("down") })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "down") {
		t.Fatalf("readyz = %d %s", rec.Code, rec.Body)
	}

	s.draining.Store(true)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if !strings.Contains(rec.Body.String(), "draining") {
		t.Fatalf("expected draining, got %s", rec.Body)
	}
}

func TestMetaAndOpenAPI(t *testing.T) {
	s := newTestServer(t)
	RegisterMeta(s.API(), []string{"edge"})
	h := s.Handler()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/meta", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("meta = %d %s", rec.Code, rec.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["name"] != "apilens" {
		t.Fatalf("body = %v", body)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"get-meta"`) {
		t.Fatalf("openapi = %d", rec.Code)
	}
	for _, tag := range []string{TagAuth, TagUsers, TagOrganizations, TagProjects} {
		if !strings.Contains(rec.Body.String(), `"name":"`+tag+`"`) {
			t.Fatalf("openapi.json does not list tag %q", tag)
		}
	}
}

func TestPanicIsRecovered(t *testing.T) {
	s := newTestServer(t)
	s.Mux().HandleFunc("GET /boom", func(http.ResponseWriter, *http.Request) { panic("boom") })
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestUseMiddlewareOrder(t *testing.T) {
	s := newTestServer(t)
	var order []string
	for _, name := range []string{"a", "b"} {
		s.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		})
	}
	rec := httptest.NewRecorder()
	// Middleware also sees requests that match no route.
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound || strings.Join(order, ",") != "a,b" {
		t.Fatalf("code=%d order=%v", rec.Code, order)
	}
}
