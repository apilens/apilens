//go:build integration

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestSSOLookupIntegration runs GET /auth/sso/lookup against Postgres
// (organizations, org_sso_connections) and Valkey (per-IP limit).
func TestSSOLookupIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	insertOrg := `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`
	insertConn := `INSERT INTO org_sso_connections (org_id, issuer, client_id, client_secret_enc, domains, enforce)
		VALUES ($1, 'https://idp.example.com', 'client', '\x01', $2, $3)`
	for _, o := range []struct {
		slug, name string
		domains    []string
		enforce    bool
	}{
		{"acme", "Acme Corp", []string{"acme.example.com"}, true},
		{"beta", "Beta Labs", []string{"beta.example.com"}, false},
		// A connection that lists public domains must still never match them.
		{"squatter", "Squatter", []string{"gmail.com", "yahoo.co.uk"}, true},
	} {
		id := uuid.New()
		if _, err := pool.Exec(ctx, insertOrg, id, o.slug, o.name); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, insertConn, id, o.domains, o.enforce); err != nil {
			t.Fatal(err)
		}
	}

	cfg := config.IdentityConfig{Issuer: "https://auth.example.com/"}
	cfg.RateLimits.SSOLookupPerIP = config.RateLimit{Limit: 7, Window: time.Minute}
	_, api := humatest.New(t)
	NewSSOLookup(cfg, db.New(pool), limiter, logger).Register(api)
	lookup := func(addr string) (int, SSOLookupResponse) {
		t.Helper()
		resp := api.Get(AuthPrefix + "/sso/lookup?email=" + addr)
		var out SSOLookupResponse
		if resp.Code == http.StatusOK {
			if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.Code, out
	}

	tests := []struct {
		email string
		want  SSOLookupResponse
	}{
		{"Ada@ACME.example.com", SSOLookupResponse{SSO: true, Enforced: true, OrgName: "Acme Corp", StartURL: "https://auth.example.com/api/v1/auth/sso/acme/start"}},
		{"bob@beta.example.com", SSOLookupResponse{SSO: true, OrgName: "Beta Labs", StartURL: "https://auth.example.com/api/v1/auth/sso/beta/start"}},
		{"carol@nobody.example.com", SSOLookupResponse{}},
		{"dave@gmail.com", SSOLookupResponse{}},
		{"erin@yahoo.co.uk", SSOLookupResponse{}},
	}
	for _, tc := range tests {
		code, got := lookup(tc.email)
		if code != http.StatusOK || got != tc.want {
			t.Errorf("%s: %d %+v, want 200 %+v", tc.email, code, got, tc.want)
		}
	}
	if code, _ := lookup("not-an-email"); code != http.StatusBadRequest {
		t.Errorf("invalid email: %d, want 400", code)
	}
	// 7 per minute per IP: 6 requests so far, so the 7th passes and the 8th
	// is limited.
	if code, _ := lookup("ada@acme.example.com"); code != http.StatusOK {
		t.Fatalf("7th request: %d, want 200", code)
	}
	resp := api.Get(AuthPrefix + "/sso/lookup?email=ada@acme.example.com")
	if resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") == "" {
		t.Fatalf("8th request: %d (Retry-After %q), want 429 with Retry-After", resp.Code, resp.Header().Get("Retry-After"))
	}
}
