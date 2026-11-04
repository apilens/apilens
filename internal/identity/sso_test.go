package identity

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/users"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeSSOConns is an in-memory SSOStore keyed by organization slug.
type fakeSSOConns struct {
	mu      sync.Mutex
	conns   map[string]db.GetOrgSSOConnectionBySlugRow
	touched []uuid.UUID
}

func (f *fakeSSOConns) GetOrgSSOConnectionBySlug(_ context.Context, slug string) (db.GetOrgSSOConnectionBySlugRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.conns[slug]
	if !ok {
		return c, pgx.ErrNoRows
	}
	return c, nil
}

func (f *fakeSSOConns) TouchOrgSSOLastLogin(_ context.Context, org uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, org)
	return nil
}

// fakeSSOUsers is an in-memory SSOUsers keyed by email.
type fakeSSOUsers struct {
	byEmail map[string]db.User
	totp    map[uuid.UUID]bool
	touched []uuid.UUID
}

func (f *fakeSSOUsers) FindOrCreateSSO(_ context.Context, email string) (db.User, bool, error) {
	u, ok := f.byEmail[email]
	if !ok {
		u = db.User{ID: uuid.New(), Email: email}
		f.byEmail[email] = u
	}
	return u, !ok, nil
}

func (f *fakeSSOUsers) TOTPConfirmed(_ context.Context, id uuid.UUID) (bool, error) {
	return f.totp[id], nil
}

func (f *fakeSSOUsers) TouchLastLogin(_ context.Context, id uuid.UUID) error {
	f.touched = append(f.touched, id)
	return nil
}

// fakeMemberships records JIT memberships.
type fakeMemberships struct {
	members map[[2]uuid.UUID]string
	joins   int
}

func (f *fakeMemberships) JoinViaSSO(_ context.Context, org, user uuid.UUID, role string) (bool, error) {
	key := [2]uuid.UUID{org, user}
	if _, ok := f.members[key]; ok {
		return false, nil
	}
	f.members[key] = role
	f.joins++
	return true, nil
}

// fakeSSOLookup is an in-memory SSOLookupStore keyed by domain.
type fakeSSOLookup map[string]db.LookupOrgSSOForDomainRow

func (f fakeSSOLookup) LookupOrgSSOForDomain(_ context.Context, domain string) (db.LookupOrgSSOForDomainRow, error) {
	r, ok := f[domain]
	if !ok {
		return r, pgx.ErrNoRows
	}
	return r, nil
}

func testSealer(t *testing.T) *idkeys.Sealer {
	t.Helper()
	kek := make([]byte, idkeys.KEKSize)
	if _, err := rand.Read(kek); err != nil {
		t.Fatal(err)
	}
	s, err := idkeys.NewSealer(kek)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type ssoHarness struct {
	api      humatest.TestAPI
	s        *SSO
	idp      *fakeIdP
	store    *fakeSSOConns
	states   *memStates
	users    *fakeSSOUsers
	members  *fakeMemberships
	sessions *fakeSessionCreator
	preAuth  *fakePreAuth
	handoff  *memHandoff
	audit    *fakeAudit
	org      uuid.UUID
}

const ssoTestIssuer = "https://id.example.com"

func newSSOHarness(t *testing.T) *ssoHarness {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	sealer := testSealer(t)
	h := &ssoHarness{
		idp:      newFakeIdP(t),
		states:   newMemStates(),
		users:    &fakeSSOUsers{byEmail: map[string]db.User{}, totp: map[uuid.UUID]bool{}},
		members:  &fakeMemberships{members: map[[2]uuid.UUID]string{}},
		sessions: &fakeSessionCreator{now: func() time.Time { return now }},
		preAuth:  &fakePreAuth{},
		handoff:  &memHandoff{m: map[string]SignInResponse{}},
		audit:    &fakeAudit{},
		org:      uuid.New(),
	}
	secret, err := SealSSOClientSecret(sealer, h.org, "sso-secret")
	if err != nil {
		t.Fatal(err)
	}
	h.store = &fakeSSOConns{conns: map[string]db.GetOrgSSOConnectionBySlugRow{
		"acme": {
			OrgID: h.org, Slug: "acme", OrgName: "Acme", Issuer: h.idp.srv.URL, ClientID: "g-id",
			ClientSecretEnc: secret, Domains: []string{"acme.example.com"}, DefaultRole: "viewer",
		},
		"beta": {
			OrgID: uuid.New(), Slug: "beta", OrgName: "Beta", Issuer: h.idp.srv.URL, ClientID: "g-id",
			ClientSecretEnc: secret, Domains: []string{"beta.example.com"}, DefaultRole: "member",
		},
	}}
	cfg := config.IdentityConfig{Issuer: ssoTestIssuer + "/", PublicUIURL: testUIURL, PreAuthTTL: 3 * time.Minute}
	h.s = NewSSO(cfg, h.states, SSODeps{
		Connections: h.store,
		Sealer:      sealer,
		Users:       h.users,
		Memberships: h.members,
		Sessions:    h.sessions,
		PreAuth:     h.preAuth,
		Handoff:     h.handoff,
		Audit:       h.audit,
	}, limiter, logger)
	h.s.now = func() time.Time { return now }
	_, h.api = humatest.New(t)
	h.s.Register(h.api)
	return h
}

func ssoStartPath(org, query string) string {
	p := AuthPrefix + "/sso/" + org + "/start"
	if query != "" {
		p += "?" + query
	}
	return p
}

func ssoCallbackPath(org string, q url.Values) string {
	return AuthPrefix + "/sso/" + org + "/callback?" + q.Encode()
}

// begin runs GET /sso/{org}/start and returns what the browser carries to
// the identity provider.
func (h *ssoHarness) begin(t *testing.T, org, query string) (startedFlow, *url.URL) {
	t.Helper()
	loc := mustLocation(t, h.api.Get(ssoStartPath(org, query)))
	q := loc.Query()
	return startedFlow{state: q.Get("state"), challenge: q.Get("code_challenge"), nonce: q.Get("nonce")}, loc
}

func (h *ssoHarness) callback(t *testing.T, org string, q url.Values) *url.URL {
	t.Helper()
	resp := h.api.Get(ssoCallbackPath(org, q))
	if resp.Code != http.StatusFound {
		t.Fatalf("callback status = %d: %s", resp.Code, resp.Body)
	}
	if resp.Header().Get("Cache-Control") != "no-store" || resp.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("headers = %v", resp.Header())
	}
	u, err := url.Parse(resp.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func (h *ssoHarness) handedOff(t *testing.T, loc *url.URL) SignInResponse {
	t.Helper()
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != testUIURL+"/auth/callback" {
		t.Fatalf("redirect = %s, want the UI callback", loc)
	}
	res, err := h.handoff.Take(context.Background(), loc.Query().Get("code"))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

// ssoGrant is a valid id_token grant for flow f.
func ssoGrant(f startedFlow, email string) idpGrant {
	return idpGrant{challenge: f.challenge, claims: map[string]any{"sub": "idp-sub-1", "nonce": f.nonce, "email": email, "name": "Ada"}}
}

func TestSSOStartRedirectsToProvider(t *testing.T) {
	h := newSSOHarness(t)
	f, loc := h.begin(t, "acme", "next=%2Fprojects&remember=true&login_hint=Ada%40ACME.example.com")
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != h.idp.srv.URL+"/authorize" {
		t.Fatalf("location = %s", loc)
	}
	q := loc.Query()
	if q.Get("client_id") != "g-id" || q.Get("response_type") != "code" ||
		q.Get("redirect_uri") != ssoTestIssuer+"/api/v1/auth/sso/acme/callback" ||
		q.Get("code_challenge_method") != "S256" || f.challenge == "" || f.nonce == "" || f.state == "" ||
		q.Get("login_hint") != "ada@acme.example.com" || !strings.Contains(q.Get("scope"), "openid") {
		t.Fatalf("authorize query = %v", q)
	}
	st := h.states.m[f.state]
	if st.Provider != SSOProvider || st.OrgID != h.org.String() || st.Next != "/projects" || !st.Remember ||
		st.Nonce != f.nonce || s256(st.Verifier) != f.challenge || h.states.ttls[f.state] != OAuthStateTTL {
		t.Fatalf("state = %+v", st)
	}

	if resp := h.api.Get(ssoStartPath("nope", "")); resp.Code != http.StatusNotFound {
		t.Fatalf("unknown org: %d", resp.Code)
	}
	if resp := h.api.Get(ssoStartPath("acme", "next=https%3A%2F%2Fevil.example.com")); resp.Code != http.StatusBadRequest {
		t.Fatalf("foreign next: %d", resp.Code)
	}
}

func TestSSOCallbackSignsInAndJoins(t *testing.T) {
	h := newSSOHarness(t)
	f, _ := h.begin(t, "acme", "remember=true")
	h.idp.Grant("c1", ssoGrant(f, "Ada@Acme.Example.com"))

	res := h.handedOff(t, h.callback(t, "acme", url.Values{"code": {"c1"}, "state": {f.state}}))
	if res.AccessToken != "access-token" || res.User == nil || res.User.Email != "ada@acme.example.com" || res.Next != users.OnboardingPath {
		t.Fatalf("handoff = %+v", res)
	}
	if !slices.Equal(h.sessions.metas[0].AMR, []string{"sso"}) || !h.sessions.remember[0] {
		t.Fatalf("session amr = %v remember = %v", h.sessions.metas[0].AMR, h.sessions.remember)
	}
	user := h.users.byEmail["ada@acme.example.com"]
	if role := h.members.members[[2]uuid.UUID{h.org, user.ID}]; role != "viewer" {
		t.Fatalf("membership role = %q, want the default role", role)
	}
	if len(h.store.touched) != 1 || h.store.touched[0] != h.org || len(h.users.touched) != 1 {
		t.Errorf("touched connection %v, user %v", h.store.touched, h.users.touched)
	}
	ev := h.audit.events[len(h.audit.events)-1]
	if ev.Kind != audit.LoginSucceeded || ev.Meta["method"] != "sso" || ev.Meta["joined"] != true || ev.Meta["org_id"] != h.org.String() {
		t.Fatalf("audit = %+v", ev)
	}

	// A second sign-in keeps the membership and does not join again.
	f2, _ := h.begin(t, "acme", "")
	h.idp.Grant("c2", ssoGrant(f2, "ada@acme.example.com"))
	res = h.handedOff(t, h.callback(t, "acme", url.Values{"code": {"c2"}, "state": {f2.state}}))
	if res.Next != "/" || h.members.joins != 1 {
		t.Fatalf("second sign-in next = %q joins = %d", res.Next, h.members.joins)
	}
	if ev := h.audit.events[len(h.audit.events)-1]; ev.Meta["joined"] != false {
		t.Fatalf("audit = %+v", ev)
	}
}

func TestSSOCallbackTwoFactor(t *testing.T) {
	h := newSSOHarness(t)
	u := db.User{ID: uuid.New(), Email: "ada@acme.example.com"}
	h.users.byEmail[u.Email] = u
	h.users.totp[u.ID] = true
	f, _ := h.begin(t, "acme", "")
	h.idp.Grant("c1", ssoGrant(f, u.Email))

	res := h.handedOff(t, h.callback(t, "acme", url.Values{"code": {"c1"}, "state": {f.state}}))
	if res.Status != "2fa_required" || res.PreAuthToken != "pre-auth-token" || res.AccessToken != "" {
		t.Fatalf("handoff = %+v", res)
	}
	if len(h.preAuth.issued) != 1 || !slices.Equal(h.preAuth.issued[0].AMR, []string{"sso"}) || h.preAuth.ttls[0] != 3*time.Minute {
		t.Fatalf("pre-auth = %+v", h.preAuth.issued)
	}
	if len(h.sessions.metas) != 0 || h.members.joins != 1 {
		t.Fatalf("sessions = %d joins = %d", len(h.sessions.metas), h.members.joins)
	}
}

func TestSSOCallbackRejects(t *testing.T) {
	tests := []struct {
		name  string
		org   string
		grant func(f startedFlow) idpGrant
		query func(f startedFlow) url.Values
		code  string
	}{
		{name: "email outside the connection's domains", grant: func(f startedFlow) idpGrant { return ssoGrant(f, "ada@other.example.com") }, code: "forbidden"},
		{name: "public mailbox", grant: func(f startedFlow) idpGrant { return ssoGrant(f, "ada@gmail.com") }, code: "forbidden"},
		{name: "email_verified false", grant: func(f startedFlow) idpGrant {
			g := ssoGrant(f, "ada@acme.example.com")
			g.claims["email_verified"] = false
			return g
		}, code: "oauth_email_unverified"},
		{name: "no email", grant: func(f startedFlow) idpGrant { return ssoGrant(f, "") }, code: "oauth_email_unverified"},
		{name: "wrong nonce", grant: func(f startedFlow) idpGrant {
			g := ssoGrant(f, "ada@acme.example.com")
			g.claims["nonce"] = "other"
			return g
		}, code: "oauth_state_mismatch"},
		{name: "wrong audience", grant: func(f startedFlow) idpGrant {
			g := ssoGrant(f, "ada@acme.example.com")
			g.claims["aud"] = "another-client"
			return g
		}, code: "oauth_state_mismatch"},
		{name: "wrong PKCE verifier", grant: func(f startedFlow) idpGrant {
			g := ssoGrant(f, "ada@acme.example.com")
			g.challenge = "nope"
			return g
		}, code: "oauth_state_mismatch"},
		{name: "state of another organization", org: "beta", grant: func(f startedFlow) idpGrant { return ssoGrant(f, "ada@beta.example.com") }, code: "oauth_state_mismatch"},
		{name: "unknown state", query: func(startedFlow) url.Values { return url.Values{"code": {"c"}, "state": {"nope"}} }, code: "oauth_state_mismatch"},
		{name: "consent declined", query: func(f startedFlow) url.Values {
			return url.Values{"error": {"access_denied"}, "state": {f.state}}
		}, code: "oauth_denied"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newSSOHarness(t)
			f, _ := h.begin(t, "acme", "")
			if tt.grant != nil {
				h.idp.Grant("c", tt.grant(f))
			}
			org := "acme"
			if tt.org != "" {
				org = tt.org
			}
			q := url.Values{"code": {"c"}, "state": {f.state}}
			if tt.query != nil {
				q = tt.query(f)
			}
			wantSignInError(t, h.callback(t, org, q), tt.code)
			if len(h.sessions.metas) != 0 || h.members.joins != 0 || len(h.store.touched) != 0 {
				t.Fatalf("signed in: sessions %d joins %d", len(h.sessions.metas), h.members.joins)
			}
			ev := h.audit.events[len(h.audit.events)-1]
			if ev.Kind != audit.LoginFailed || ev.Meta["method"] != "sso" || ev.Meta["code"] != tt.code {
				t.Fatalf("audit = %+v", ev)
			}
			// The state is burned either way.
			if _, ok := h.states.m[f.state]; ok && tt.query == nil {
				t.Fatal("state not burned")
			}
		})
	}
}

func TestSSOCallbackRefusesSocialState(t *testing.T) {
	h := newSSOHarness(t)
	if err := h.states.Put(context.Background(), "social", OAuthState{Provider: "google", Verifier: "v", Nonce: "n", Intent: OAuthIntentLogin}, OAuthStateTTL); err != nil {
		t.Fatal(err)
	}
	wantSignInError(t, h.callback(t, "acme", url.Values{"code": {"c"}, "state": {"social"}}), "oauth_state_mismatch")
	if resp := h.api.Get(ssoCallbackPath("nope", url.Values{"code": {"c"}, "state": {"s"}})); resp.Code != http.StatusNotFound {
		t.Fatalf("unknown org: %d", resp.Code)
	}
}

func TestSSOClientSecretBoundToOrg(t *testing.T) {
	s := testSealer(t)
	a, b := uuid.New(), uuid.New()
	sealed, err := SealSSOClientSecret(s, a, "top-secret")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := OpenSSOClientSecret(s, a, sealed); err != nil || got != "top-secret" {
		t.Fatalf("open = %q, %v", got, err)
	}
	if _, err := OpenSSOClientSecret(s, b, sealed); !errors.Is(err, idkeys.ErrDecrypt) {
		t.Fatalf("open for another org: %v", err)
	}
}

func TestSSOEnforcementRequired(t *testing.T) {
	e := NewSSOEnforcement(fakeSSOLookup{
		"acme.example.com": {Slug: "acme", Name: "Acme", Enforce: true},
		"beta.example.com": {Slug: "beta", Name: "Beta", Enforce: false},
		"gmail.com":        {Slug: "squatter", Enforce: true},
	}, "https://id.example.com/")
	ctx := context.Background()
	for addr, want := range map[string]bool{
		"ada@acme.example.com": true, "ada@beta.example.com": false, "ada@gmail.com": false, "ada@example.com": false,
	} {
		u, got, err := e.Required(ctx, addr)
		if err != nil || got != want {
			t.Errorf("%s: required = %v, %v", addr, got, err)
		}
		if want && u != "https://id.example.com/api/v1/auth/sso/acme/start" {
			t.Errorf("%s: start url = %q", addr, u)
		}
	}
	var none *SSOEnforcement
	if _, got, err := none.Required(ctx, "ada@acme.example.com"); got || err != nil {
		t.Fatalf("nil enforcement: %v %v", got, err)
	}
}

func TestEmailStartSSORequired(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	tokens := &fakeEmailTokens{now: time.Now}
	jobs := &fakeJobs{}
	e := NewEmailStart(config.IdentityConfig{}, EmailStartDeps{
		Tokens: tokens, Users: &fakeUsers{byEmail: map[string]db.User{}}, Jobs: jobs, Audit: &fakeAudit{},
		SSO: NewSSOEnforcement(fakeSSOLookup{"acme.example.com": {Slug: "acme", Enforce: true}}, "https://id.example.com"),
	}, limiter, logger)
	_, api := humatest.New(t)
	e.Register(api)

	resp := api.Post(AuthPrefix+"/email/start", map[string]any{"email": "Ada@Acme.example.com", "intent": "signin"})
	if resp.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var p map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p["code"] != "sso_required" || p["start_url"] != "https://id.example.com/api/v1/auth/sso/acme/start" {
		t.Fatalf("problem = %v", p)
	}
	if len(jobs.jobs) != 0 || len(tokens.rows) != 0 {
		t.Fatalf("email sent: jobs %d rows %d", len(jobs.jobs), len(tokens.rows))
	}
	if resp := api.Post(AuthPrefix+"/email/start", map[string]any{"email": "ada@example.com", "intent": "signin"}); resp.Code != http.StatusOK {
		t.Fatalf("other domain: %d %s", resp.Code, resp.Body)
	}
}

func TestOAuthCallbackSSORequired(t *testing.T) {
	h := newCallbackHarness(t)
	h.o.signIn.SSO = NewSSOEnforcement(fakeSSOLookup{"acme.example.com": {Slug: "acme", Enforce: true}}, "https://id.example.com")
	f := beginOAuth(t, h.api, "google", "")
	h.idp.Grant("g-code", googleGrant(f, "google-sub-1", "ada@acme.example.com"))
	wantSignInError(t, h.callback(t, "google", url.Values{"code": {"g-code"}, "state": {f.state}}), "sso_required")
	if len(h.users.seen) != 0 || len(h.sessions.metas) != 0 {
		t.Fatalf("signed in: users %v sessions %d", h.users.seen, len(h.sessions.metas))
	}
	if ev := h.lastEvent(t); ev.Kind != audit.LoginFailed || ev.Meta["code"] != "sso_required" {
		t.Fatalf("audit = %+v", ev)
	}
}
