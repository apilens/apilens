//go:build integration

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

const (
	// testKEK is the identity key-encryption key of the API tests.
	testKEK = "itest-identity-kek-0123456789abc"
	// testIssuer is the identity issuer URL of the API tests.
	testIssuer = "https://id.example.com"
)

// ssoBody is a PUT /orgs/{slug}/sso body.
func ssoBody(issuer string, secret *string, enforce bool, domains ...string) map[string]any {
	if domains == nil {
		domains = []string{}
	}
	b := map[string]any{"issuer": issuer, "client_id": "apilens", "domains": domains, "enforce": enforce}
	if secret != nil {
		b["client_secret"] = *secret
	}
	return b
}

func ptr[T any](v T) *T { return &v }

// ssoSignIn records that user signed in through org's SSO connection, as
// the identity SSO callback does.
func (f *orgsFixture) ssoSignIn(t *testing.T, user uuid.UUID, org string) {
	t.Helper()
	if err := audit.New(f.pool).Record(f.ctx, audit.Event{
		User: &user, Actor: &user, Kind: audit.LoginSucceeded,
		Meta: map[string]any{"method": "sso", "amr": []string{"sso"}, "org_id": org},
	}); err != nil {
		t.Fatal(err)
	}
}

func (f *orgsFixture) storedSecret(t *testing.T, org string) string {
	t.Helper()
	var enc []byte
	if err := f.pool.QueryRow(f.ctx, `SELECT client_secret_enc FROM org_sso_connections WHERE org_id = $1`, org).Scan(&enc); err != nil {
		t.Fatal(err)
	}
	s, err := identity.OpenSSOClientSecret(f.sealer, uuid.MustParse(org), enc)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSSOConnectionCRUD(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "sso-owner@example.com")
	admin := f.user(t, "sso-admin@example.com")
	member := f.user(t, "sso-member@example.com")
	viewer := f.user(t, "sso-viewer@example.com")
	stranger := f.user(t, "sso-stranger@example.com")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	path := OrgsPath + "/acme/sso"

	if resp := f.api.Get(path, as(owner)); resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "sso_not_configured" {
		t.Fatalf("get before create: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Delete(path, as(owner)); resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "sso_not_configured" {
		t.Fatalf("delete before create: %d %s", resp.Code, resp.Body)
	}
	// A new connection needs a secret.
	if resp := f.api.Put(path, as(owner), ssoBody("https://idp.example.com", nil, false, "example.com")); resp.Code != http.StatusBadRequest || decode[problem](t, resp).Code != "invalid_request" {
		t.Fatalf("put without secret: %d %s", resp.Code, resp.Body)
	}

	resp := f.api.Put(path, as(owner), ssoBody("https://idp.example.com", ptr("s3cret-one"), false, "example.com", "example.org", "example.com"))
	if resp.Code != http.StatusOK {
		t.Fatalf("create: %d %s", resp.Code, resp.Body)
	}
	if strings.Contains(resp.Body.String(), "s3cret-one") {
		t.Fatalf("response leaks the secret: %s", resp.Body)
	}
	c := decode[SSOConnectionBody](t, resp)
	if c.Issuer != "https://idp.example.com" || c.ClientID != "apilens" || c.ClientSecret != orgs.SSOSecretMask ||
		!slices.Equal(c.Domains, []string{"example.com", "example.org"}) || c.Enforce || c.DefaultRole != "member" ||
		c.RedirectURI != testIssuer+"/api/v1/auth/sso/acme/callback" || c.StartURL != testIssuer+"/api/v1/auth/sso/acme/start" ||
		c.CreatedAt.IsZero() || c.LastLoginAt != nil {
		t.Fatalf("created = %+v", c)
	}
	if got := f.storedSecret(t, org.ID); got != "s3cret-one" {
		t.Fatalf("stored secret = %q", got)
	}
	if n := f.count(t, `SELECT count(*) FROM org_sso_connections WHERE position('s3cret-one'::bytea in client_secret_enc) > 0`); n != 0 {
		t.Fatal("secret stored in the clear")
	}
	if got := decode[SSOConnectionBody](t, f.api.Get(path, as(owner))); got.Issuer != c.Issuer || got.ClientSecret != orgs.SSOSecretMask || len(got.Domains) != 2 {
		t.Fatalf("get = %+v", got)
	}

	// Omitting the secret, or sending the mask back, keeps it.
	body := ssoBody("https://login.example.com/tenant/", nil, false, "example.com")
	body["default_role"] = "viewer"
	if resp := f.api.Put(path, as(owner), body); resp.Code != http.StatusOK {
		t.Fatalf("update: %d %s", resp.Code, resp.Body)
	} else if c := decode[SSOConnectionBody](t, resp); c.Issuer != "https://login.example.com/tenant/" || c.DefaultRole != "viewer" || len(c.Domains) != 1 {
		t.Fatalf("updated = %+v", c)
	}
	if resp := f.api.Put(path, as(owner), ssoBody("https://login.example.com/tenant/", ptr(orgs.SSOSecretMask), false, "example.com")); resp.Code != http.StatusOK {
		t.Fatalf("update with mask: %d %s", resp.Code, resp.Body)
	}
	if got := f.storedSecret(t, org.ID); got != "s3cret-one" {
		t.Fatalf("secret after keep = %q", got)
	}
	if resp := f.api.Put(path, as(owner), ssoBody("https://login.example.com/tenant/", ptr("s3cret-two"), false, "example.com")); resp.Code != http.StatusOK {
		t.Fatalf("rotate secret: %d %s", resp.Code, resp.Body)
	}
	if got := f.storedSecret(t, org.ID); got != "s3cret-two" {
		t.Fatalf("secret after rotate = %q", got)
	}

	valid := ssoBody("https://idp.example.com", ptr("x"), false, "example.com")
	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		method string
		body   map[string]any
		status int
		code   string
	}{
		{"admin get", admin, http.MethodGet, nil, http.StatusForbidden, "forbidden"},
		{"admin put", admin, http.MethodPut, valid, http.StatusForbidden, "forbidden"},
		{"admin delete", admin, http.MethodDelete, nil, http.StatusForbidden, "forbidden"},
		{"member get", member, http.MethodGet, nil, http.StatusForbidden, "forbidden"},
		{"viewer put", viewer, http.MethodPut, valid, http.StatusForbidden, "forbidden"},
		{"stranger get", stranger, http.MethodGet, nil, http.StatusNotFound, "not_found"},
		{"stranger put", stranger, http.MethodPut, valid, http.StatusNotFound, "not_found"},
		{"public domain", owner, http.MethodPut, ssoBody("https://idp.example.com", nil, false, "gmail.com"), http.StatusBadRequest, "domain_not_allowed"},
		{"upper-case domain", owner, http.MethodPut, ssoBody("https://idp.example.com", nil, false, "Example.com"), http.StatusBadRequest, "invalid_request"},
		{"plain http issuer", owner, http.MethodPut, ssoBody("http://idp.example.com", nil, false, "example.com"), http.StatusBadRequest, "invalid_request"},
		{"issuer with query", owner, http.MethodPut, ssoBody("https://idp.example.com/?x=1", nil, false, "example.com"), http.StatusBadRequest, "invalid_request"},
		{"owner role", owner, http.MethodPut, func() map[string]any {
			b := ssoBody("https://idp.example.com", nil, false, "example.com")
			b["default_role"] = "owner"
			return b
		}(), http.StatusUnprocessableEntity, ""},
		{"no domains", owner, http.MethodPut, ssoBody("https://idp.example.com", nil, false), http.StatusUnprocessableEntity, ""},
	} {
		var resp *httptest.ResponseRecorder
		switch tc.method {
		case http.MethodGet:
			resp = f.api.Get(path, as(tc.user))
		case http.MethodPut:
			resp = f.api.Put(path, as(tc.user), tc.body)
		case http.MethodDelete:
			resp = f.api.Delete(path, as(tc.user))
		}
		if resp.Code != tc.status || (tc.code != "" && decode[problem](t, resp).Code != tc.code) {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if got := decode[SSOConnectionBody](t, f.api.Get(path, as(owner))); got.Issuer != "https://login.example.com/tenant/" || got.DefaultRole != "member" {
		// The rotate above omitted default_role, which defaults to member.
		t.Fatalf("rejected writes changed the connection: %+v", got)
	}

	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'sso.updated' AND actor_user_id = $1`, owner); n != 4 {
		t.Fatalf("sso.updated events = %d, want 4", n)
	}
	var meta map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT metadata FROM audit_events WHERE event = 'sso.updated' ORDER BY id DESC LIMIT 1`).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	if meta["org_id"] != org.ID || meta["created"] != false || meta["secret_changed"] != true || strings.Contains(mustJSON(t, meta), "s3cret") {
		t.Fatalf("audit meta = %v", meta)
	}

	if resp := f.api.Delete(path, as(owner)); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Get(path, as(owner)); resp.Code != http.StatusConflict {
		t.Fatalf("get after delete: %d", resp.Code)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'sso.deleted' AND metadata->>'org_id' = $1`, org.ID); n != 1 {
		t.Fatalf("sso.deleted events = %d", n)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSSOEnforceNeedsTestedSignIn(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "enf-owner@example.com")
	other := f.user(t, "enf-other@example.com")
	acme := f.mustCreate(t, owner, "Acme", "acme")
	globex := f.mustCreate(t, other, "Globex", "globex")
	path := OrgsPath + "/acme/sso"
	untested := func(resp *httptest.ResponseRecorder, what string) {
		t.Helper()
		if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "sso_untested" {
			t.Fatalf("%s: %d %s", what, resp.Code, resp.Body)
		}
	}

	// A new connection cannot start enforced: nobody has used it yet.
	untested(f.api.Put(path, as(owner), ssoBody("https://idp.example.com", ptr("s"), true, "acme.example")), "create enforced")
	if n := f.count(t, `SELECT count(*) FROM org_sso_connections`); n != 0 {
		t.Fatalf("connections = %d", n)
	}
	if resp := f.api.Put(path, as(owner), ssoBody("https://idp.example.com", ptr("s"), false, "acme.example")); resp.Code != http.StatusOK {
		t.Fatalf("create: %d %s", resp.Code, resp.Body)
	}
	untested(f.api.Put(path, as(owner), ssoBody("https://idp.example.com", nil, true, "acme.example")), "enforce untested")

	// An SSO sign-in to another organization, or by another user, does not
	// count.
	f.ssoSignIn(t, owner, globex.ID)
	f.ssoSignIn(t, other, acme.ID)
	untested(f.api.Put(path, as(owner), ssoBody("https://idp.example.com", nil, true, "acme.example")), "enforce after unrelated sign-ins")

	f.ssoSignIn(t, owner, acme.ID)
	resp := f.api.Put(path, as(owner), ssoBody("https://idp.example.com", nil, true, "acme.example"))
	if resp.Code != http.StatusOK || !decode[SSOConnectionBody](t, resp).Enforce {
		t.Fatalf("enforce after sign-in: %d %s", resp.Code, resp.Body)
	}
	// Keeping it on needs nothing more.
	if resp := f.api.Put(path, as(owner), ssoBody("https://idp2.example.com", nil, true, "acme.example")); resp.Code != http.StatusOK {
		t.Fatalf("edit while enforced: %d %s", resp.Code, resp.Body)
	}

	// A sign-in through an earlier connection does not test a new one.
	if resp := f.api.Delete(path, as(owner)); resp.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", resp.Code)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE audit_events SET created_at = now() - interval '1 minute' WHERE event = 'login.succeeded'`); err != nil {
		t.Fatal(err)
	}
	if resp := f.api.Put(path, as(owner), ssoBody("https://idp.example.com", ptr("s"), false, "acme.example")); resp.Code != http.StatusOK {
		t.Fatalf("recreate: %d %s", resp.Code, resp.Body)
	}
	untested(f.api.Put(path, as(owner), ssoBody("https://idp.example.com", nil, true, "acme.example")), "enforce recreated")

	// A sign-in completed after a second factor carries the org too (the
	// 2FA exchange records it), so it counts the same way.
	f.ssoSignIn(t, owner, acme.ID)
	if resp := f.api.Put(path, as(owner), ssoBody("https://idp.example.com", nil, true, "acme.example")); resp.Code != http.StatusOK {
		t.Fatalf("enforce recreated after sign-in: %d %s", resp.Code, resp.Body)
	}

	// Another organization cannot enforce a domain Acme enforces; it may
	// still list it without enforcing.
	gpath := OrgsPath + "/globex/sso"
	if resp := f.api.Put(gpath, as(other), ssoBody("https://idp.globex.example", ptr("g"), false, "globex.example", "acme.example")); resp.Code != http.StatusOK {
		t.Fatalf("globex create: %d %s", resp.Code, resp.Body)
	}
	f.ssoSignIn(t, other, globex.ID)
	resp = f.api.Put(gpath, as(other), ssoBody("https://idp.globex.example", nil, true, "globex.example", "acme.example"))
	if resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "sso_domain_taken" {
		t.Fatalf("globex enforce taken domain: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Put(gpath, as(other), ssoBody("https://idp.globex.example", nil, true, "globex.example")); resp.Code != http.StatusOK {
		t.Fatalf("globex enforce own domain: %d %s", resp.Code, resp.Body)
	}
}

func TestSSOConnectionTest(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "test-owner@example.com")
	admin := f.user(t, "test-admin@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	path := OrgsPath + "/acme/sso/test"

	var idp *httptest.Server
	var mismatch bool
	idp = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			iss := idp.URL
			if mismatch {
				iss = "https://evil.example.com"
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issuer":                                iss,
				"authorization_endpoint":                idp.URL + "/authorize",
				"token_endpoint":                        idp.URL + "/token",
				"userinfo_endpoint":                     idp.URL + "/userinfo",
				"jwks_uri":                              idp.URL + "/jwks",
				"scopes_supported":                      []string{"openid", "email", "profile"},
				"response_types_supported":              []string{"code"},
				"id_token_signing_alg_values_supported": []string{"RS256"},
			})
		case "/broken/.well-known/openid-configuration":
			_, _ = w.Write([]byte("<html>"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(idp.Close)

	// Nothing saved and no issuer given.
	if resp := f.api.Post(path, as(owner), map[string]any{}); resp.Code != http.StatusConflict || decode[problem](t, resp).Code != "sso_not_configured" {
		t.Fatalf("test without connection: %d %s", resp.Code, resp.Body)
	}

	resp := f.api.Post(path, as(owner), map[string]any{"issuer": idp.URL})
	if resp.Code != http.StatusOK {
		t.Fatalf("test: %d %s", resp.Code, resp.Body)
	}
	r := decode[SSOTestBody](t, resp)
	if !r.OK || r.Issuer != idp.URL || r.Error != "" || r.AuthorizationEndpoint != idp.URL+"/authorize" || r.TokenEndpoint != idp.URL+"/token" ||
		r.JWKSURI != idp.URL+"/jwks" || r.UserinfoEndpoint != idp.URL+"/userinfo" || !slices.Equal(r.ScopesSupported, []string{"openid", "email", "profile"}) ||
		!slices.Equal(r.SigningAlgs, []string{"RS256"}) {
		t.Fatalf("result = %+v", r)
	}

	// Without an issuer the saved connection is tested.
	if resp := f.api.Put(OrgsPath+"/acme/sso", as(owner), ssoBody(idp.URL, ptr("s"), false, "acme.example")); resp.Code != http.StatusOK {
		t.Fatalf("save: %d %s", resp.Code, resp.Body)
	}
	if r := decode[SSOTestBody](t, f.api.Post(path, as(owner), map[string]any{})); !r.OK || r.Issuer != idp.URL {
		t.Fatalf("saved = %+v", r)
	}
	if resp := f.api.Post(path, as(owner)); resp.Code != http.StatusOK || !decode[SSOTestBody](t, resp).OK {
		t.Fatalf("no body: %d %s", resp.Code, resp.Body)
	}

	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()
	mismatch = true
	for _, tc := range []struct {
		issuer string
		err    string
		status int
	}{
		{idp.URL, orgs.SSOTestIssuerMismatch, 0},
		{idp.URL + "/missing", orgs.SSOTestBadStatus, http.StatusNotFound},
		{idp.URL + "/broken", orgs.SSOTestInvalidDocument, 0},
		{closedURL, orgs.SSOTestUnreachable, 0},
	} {
		resp := f.api.Post(path, as(owner), map[string]any{"issuer": tc.issuer})
		r := decode[SSOTestBody](t, resp)
		if resp.Code != http.StatusOK || r.OK || r.Error != tc.err || r.HTTPStatus != tc.status || r.TokenEndpoint != "" {
			t.Errorf("%s: %d %s", tc.issuer, resp.Code, resp.Body)
		}
	}

	if resp := f.api.Post(path, as(owner), map[string]any{"issuer": "http://idp.example.com"}); resp.Code != http.StatusBadRequest || decode[problem](t, resp).Code != "invalid_request" {
		t.Fatalf("non-loopback http: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Post(path, as(admin), map[string]any{"issuer": idp.URL}); resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "forbidden" {
		t.Fatalf("admin: %d %s", resp.Code, resp.Body)
	}
}
