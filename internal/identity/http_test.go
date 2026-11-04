package identity

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
)

type pingOutput struct {
	Body struct {
		OK bool `json:"ok"`
	}
}

// newTestHandler builds a server with the identity middleware and a probe
// operation under /api/v1/auth, plus one outside it.
func newTestHandler(t *testing.T, cors ...string) http.Handler {
	t.Helper()
	s := server.New(config.ServerConfig{Addr: ":0"}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	s.Use(Middleware(config.IdentityConfig{Issuer: "https://api.example.com", CORSOrigins: cors}))
	handler := func(context.Context, *struct{}) (*pingOutput, error) {
		out := &pingOutput{}
		out.Body.OK = true
		return out, nil
	}
	for _, op := range []huma.Operation{
		{OperationID: "auth-get", Method: http.MethodGet, Path: AuthPrefix + "/probe"},
		{OperationID: "auth-post", Method: http.MethodPost, Path: AuthPrefix + "/probe"},
		{OperationID: "other-get", Method: http.MethodGet, Path: server.APIPrefix + "/other"},
	} {
		huma.Register(s.API(), op, handler)
	}
	return s.Handler()
}

func serve(h http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func assertSecurityHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for k, want := range map[string]string{
		"Cache-Control":          "no-store",
		"Referrer-Policy":        "no-referrer",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Error("identity must not set cookies")
	}
}

func TestSecurityHeadersOnAuthEndpoints(t *testing.T) {
	h := newTestHandler(t)
	for _, tc := range []struct {
		method, path string
		code         int
	}{
		{http.MethodGet, AuthPrefix + "/probe", http.StatusOK},
		{http.MethodPost, AuthPrefix + "/probe", http.StatusOK},
		{http.MethodGet, AuthPrefix + "/missing", http.StatusNotFound},
		{http.MethodGet, AuthPrefix, http.StatusNotFound},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			rec := serve(h, tc.method, tc.path, nil)
			if rec.Code != tc.code {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.code, rec.Body)
			}
			assertSecurityHeaders(t, rec)
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
				t.Errorf("Access-Control-Allow-Origin = %q, want none", got)
			}
		})
	}
}

func TestNonAuthPathsUntouched(t *testing.T) {
	h := newTestHandler(t)
	for _, path := range []string{server.APIPrefix + "/other", server.APIPrefix + "/authz", "/livez"} {
		rec := serve(h, http.MethodGet, path, map[string]string{"Origin": "https://evil.example"})
		if rec.Header().Get("Cache-Control") != "" || rec.Header().Get("Referrer-Policy") != "" {
			t.Errorf("%s got identity headers: %v", path, rec.Header())
		}
	}
}

func TestCORSDeniedByDefault(t *testing.T) {
	h := newTestHandler(t)
	preflight := map[string]string{"Origin": "https://app.example.com", "Access-Control-Request-Method": "POST"}
	rec := serve(h, http.MethodOptions, AuthPrefix+"/probe", preflight)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("preflight status = %d, want 403", rec.Code)
	}
	assertSecurityHeaders(t, rec)
	for _, k := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Credentials"} {
		if v := rec.Header().Get(k); v != "" {
			t.Errorf("%s = %q, want none", k, v)
		}
	}

	rec = serve(h, http.MethodGet, AuthPrefix+"/probe", map[string]string{"Origin": "https://app.example.com"})
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("simple GET = %d ACAO=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestCORSOptIn(t *testing.T) {
	h := newTestHandler(t, "https://app.example.com")

	preflight := map[string]string{"Origin": "https://APP.example.com:443", "Access-Control-Request-Method": "POST"}
	rec := serve(h, http.MethodOptions, AuthPrefix+"/probe", preflight)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	assertSecurityHeaders(t, rec)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://APP.example.com:443" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" || rec.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Errorf("preflight headers missing: %v", rec.Header())
	}
	if rec.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Error("credentials must never be allowed")
	}
	if rec.Header().Get("Vary") != "Origin" {
		t.Errorf("Vary = %q", rec.Header().Get("Vary"))
	}

	rec = serve(h, http.MethodPost, AuthPrefix+"/probe", map[string]string{"Origin": "https://app.example.com"})
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" {
		t.Fatalf("allowed POST = %d ACAO=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}

	rec = serve(h, http.MethodOptions, AuthPrefix+"/probe",
		map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
	if rec.Code != http.StatusForbidden || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("other origin preflight = %d ACAO=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestCrossOriginStateChangeRejected(t *testing.T) {
	h := newTestHandler(t, "https://app.example.com")
	for _, tc := range []struct {
		name   string
		origin string
		code   int
	}{
		{"server-side caller without Origin", "", http.StatusOK},
		{"allowed CORS origin", "https://app.example.com", http.StatusOK},
		{"issuer origin", "https://api.example.com", http.StatusOK},
		{"foreign origin", "https://evil.example", http.StatusForbidden},
		{"opaque origin", "null", http.StatusForbidden},
		{"scheme downgrade", "http://app.example.com", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := map[string]string{}
			if tc.origin != "" {
				headers["Origin"] = tc.origin
			}
			rec := serve(h, http.MethodPost, AuthPrefix+"/probe", headers)
			if rec.Code != tc.code {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.code, rec.Body)
			}
			assertSecurityHeaders(t, rec)
		})
	}

	// Top-level navigations (OAuth callbacks, magic-link redirect) are GETs
	// from foreign origins and must keep working.
	rec := serve(h, http.MethodGet, AuthPrefix+"/probe", map[string]string{"Origin": "https://accounts.google.com"})
	if rec.Code != http.StatusOK {
		t.Fatalf("cross-origin GET = %d", rec.Code)
	}
}
