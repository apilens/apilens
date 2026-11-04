package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeSSOStore maps a domain to its organization.
type fakeSSOStore struct {
	rows    map[string]db.LookupOrgSSOForDomainRow
	err     error
	queried []string
}

func (f *fakeSSOStore) LookupOrgSSOForDomain(_ context.Context, domain string) (db.LookupOrgSSOForDomainRow, error) {
	f.queried = append(f.queried, domain)
	if f.err != nil {
		return db.LookupOrgSSOForDomainRow{}, f.err
	}
	row, ok := f.rows[domain]
	if !ok {
		return db.LookupOrgSSOForDomainRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func newSSOLookupAPI(t *testing.T, cfg config.IdentityConfig, store SSOLookupStore) humatest.TestAPI {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, err := ratelimit.New(nil, logger, nil) // zero rates: limits disabled
	if err != nil {
		t.Fatal(err)
	}
	_, api := humatest.New(t)
	NewSSOLookup(cfg, store, limiter, logger).Register(api)
	return api
}

func ssoLookup(t *testing.T, api humatest.TestAPI, addr string) (int, map[string]any) {
	t.Helper()
	resp := api.Get(AuthPrefix + "/sso/lookup?email=" + url.QueryEscape(addr))
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	return resp.Code, out
}

func TestSSOLookup(t *testing.T) {
	store := &fakeSSOStore{rows: map[string]db.LookupOrgSSOForDomainRow{
		"acme.example.com": {Slug: "acme", Name: "Acme Corp", Enforce: true},
		"beta.example.com": {Slug: "beta", Name: "Beta Labs"},
	}}
	api := newSSOLookupAPI(t, config.IdentityConfig{Issuer: "https://auth.example.com"}, store)

	code, out := ssoLookup(t, api, " Ada@Acme.Example.com ")
	want := map[string]any{"sso": true, "enforced": true, "org_name": "Acme Corp", "start_url": "https://auth.example.com/api/v1/auth/sso/acme/start"}
	if code != http.StatusOK || !jsonEqual(out, want) {
		t.Errorf("enforced: %d %v, want %v", code, out, want)
	}
	code, out = ssoLookup(t, api, "bob@beta.example.com")
	want = map[string]any{"sso": true, "enforced": false, "org_name": "Beta Labs", "start_url": "https://auth.example.com/api/v1/auth/sso/beta/start"}
	if code != http.StatusOK || !jsonEqual(out, want) {
		t.Errorf("not enforced: %d %v, want %v", code, out, want)
	}
	// No organization: no org_name or start_url keys at all.
	code, out = ssoLookup(t, api, "carol@other.example.com")
	if want := map[string]any{"sso": false, "enforced": false}; code != http.StatusOK || !jsonEqual(out, want) {
		t.Errorf("no sso: %d %v, want %v", code, out, want)
	}
}

func TestSSOLookupPublicDomainsNeverMatch(t *testing.T) {
	store := &fakeSSOStore{rows: map[string]db.LookupOrgSSOForDomainRow{
		"gmail.com":   {Slug: "squatter", Name: "Squatter", Enforce: true},
		"yahoo.co.uk": {Slug: "squatter", Name: "Squatter", Enforce: true},
	}}
	api := newSSOLookupAPI(t, config.IdentityConfig{}, store)
	for _, addr := range []string{"ada@gmail.com", "ada@GMAIL.com", "ada@yahoo.co.uk", "ada@outlook.com", "ada@proton.me"} {
		code, out := ssoLookup(t, api, addr)
		if want := map[string]any{"sso": false, "enforced": false}; code != http.StatusOK || !jsonEqual(out, want) {
			t.Errorf("%s: %d %v, want %v", addr, code, out, want)
		}
	}
	if len(store.queried) != 0 {
		t.Errorf("public domains reached the store: %v", store.queried)
	}
}

func TestSSOLookupInvalid(t *testing.T) {
	store := &fakeSSOStore{}
	api := newSSOLookupAPI(t, config.IdentityConfig{}, store)
	for _, addr := range []string{"not-an-email", "ada@localhost", "Ada <ada@example.com>"} {
		if code, out := ssoLookup(t, api, addr); code != http.StatusBadRequest || out["code"] != string(CodeInvalidRequest) {
			t.Errorf("%q: %d %v, want 400 invalid_request", addr, code, out)
		}
	}
	if resp := api.Get(AuthPrefix + "/sso/lookup"); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing email: %d, want 422", resp.Code)
	}
	if len(store.queried) != 0 {
		t.Errorf("invalid requests reached the store: %v", store.queried)
	}
}

func TestSSOLookupStoreError(t *testing.T) {
	api := newSSOLookupAPI(t, config.IdentityConfig{}, &fakeSSOStore{err: errors.New("db down")})
	if code, out := ssoLookup(t, api, "ada@acme.example.com"); code != http.StatusInternalServerError || out["code"] != string(CodeInternal) {
		t.Fatalf("%d %v, want 500 internal_error", code, out)
	}
}

func TestSSOLookupRateLimiterUnavailable(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, _ := ratelimit.New(nil, logger, nil) // no Valkey: fails closed
	cfg := config.IdentityConfig{}
	cfg.RateLimits.SSOLookupPerIP = config.RateLimit{Limit: 5, Window: time.Minute}
	store := &fakeSSOStore{}
	_, api := humatest.New(t)
	NewSSOLookup(cfg, store, limiter, logger).Register(api)
	resp := api.Get(AuthPrefix + "/sso/lookup?email=ada@acme.example.com")
	if resp.Code != http.StatusServiceUnavailable || len(store.queried) != 0 {
		t.Fatalf("status = %d, queried %v; want 503 and no lookup", resp.Code, store.queried)
	}
}

func TestIsPublicEmailDomain(t *testing.T) {
	for _, d := range []string{"gmail.com", "Gmail.com", "gmail.com.", "outlook.com", "hotmail.fr", "yahoo.co.uk", "yahoo.com.br", "gmx.at", "icloud.com", "proton.me", "qq.com"} {
		if !IsPublicEmailDomain(d) {
			t.Errorf("%s: want public", d)
		}
	}
	for _, d := range []string{"acme.com", "example.com", "live.acme.com", "yahoo.example.com", "gmail.co.uk.evil.example", "mail.acme.io", ""} {
		if IsPublicEmailDomain(d) {
			t.Errorf("%s: want not public", d)
		}
	}
}

// jsonEqual compares a decoded JSON object with want by re-encoding both.
func jsonEqual(got, want map[string]any) bool {
	a, _ := json.Marshal(got)
	b, _ := json.Marshal(want)
	return bytes.Equal(a, b)
}
