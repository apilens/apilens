package identity

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// memStates is an in-memory OAuthStateStore.
type memStates struct {
	mu   sync.Mutex
	m    map[string]OAuthState
	ttls map[string]time.Duration
	err  error
}

func newMemStates() *memStates {
	return &memStates{m: map[string]OAuthState{}, ttls: map[string]time.Duration{}}
}

func (s *memStates) Put(_ context.Context, state string, st OAuthState, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	if _, ok := s.m[state]; ok {
		return errors.New("collision")
	}
	s.m[state], s.ttls[state] = st, ttl
	return nil
}

func (s *memStates) Take(_ context.Context, state string) (OAuthState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.m[state]
	if !ok {
		return OAuthState{}, ErrOAuthStateNotFound
	}
	delete(s.m, state)
	return st, nil
}

// fakeGoogle serves an OIDC discovery document for its own URL.
func fakeGoogle(t *testing.T) (issuer string, hits *int) {
	t.Helper()
	var n int
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		n++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                srv.URL,
			"authorization_endpoint":                srv.URL + "/o/oauth2/v2/auth",
			"token_endpoint":                        srv.URL + "/token",
			"jwks_uri":                              srv.URL + "/certs",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &n
}

var testOAuthCfg = config.IdentityConfig{
	Issuer: "https://id.example.com",
	OAuth: config.OAuthConfig{
		Google: config.OAuthProviderConfig{ClientID: "g-id", ClientSecret: "g-secret"},
		GitHub: config.OAuthProviderConfig{ClientID: "gh-id", ClientSecret: "gh-secret"},
	},
}

func newTestOAuth(t *testing.T, cfg config.IdentityConfig, states OAuthStateStore, limiter *ratelimit.Limiter) (humatest.TestAPI, *OAuth) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if limiter == nil {
		var err error
		if limiter, err = ratelimit.New(nil, logger, nil); err != nil {
			t.Fatal(err)
		}
	}
	o := NewOAuth(cfg, states, limiter, logger)
	if g := o.Provider(config.OAuthProviderGoogle); g != nil {
		issuer, _ := fakeGoogle(t)
		g.issuer = issuer
	}
	_, api := humatest.New(t)
	o.Register(api)
	return api, o
}

func startPath(provider, query string) string {
	p := AuthPrefix + "/oauth/" + provider + "/start"
	if query != "" {
		p += "?" + query
	}
	return p
}

func s256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func TestOAuthStartURLConstruction(t *testing.T) {
	states := newMemStates()
	api, _ := newTestOAuth(t, testOAuthCfg, states, nil)

	t.Run("github", func(t *testing.T) {
		resp := api.Get(startPath("github", "next=/projects/acme%3Ftab%3D1&remember=true"))
		if resp.Code != http.StatusFound {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		loc, err := url.Parse(resp.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if got := loc.Scheme + "://" + loc.Host + loc.Path; got != "https://github.com/login/oauth/authorize" {
			t.Errorf("authorize URL = %s", got)
		}
		q := loc.Query()
		checkParams(t, q, map[string]string{
			"response_type":         "code",
			"client_id":             "gh-id",
			"redirect_uri":          "https://id.example.com/api/v1/auth/oauth/github/callback",
			"scope":                 "read:user user:email",
			"code_challenge_method": "S256",
		})
		if q.Has("nonce") {
			t.Errorf("github is not OIDC; nonce = %q", q.Get("nonce"))
		}
		st, err := states.Take(context.Background(), q.Get("state"))
		if err != nil {
			t.Fatalf("state %q not stored: %v", q.Get("state"), err)
		}
		want := OAuthState{Provider: "github", Verifier: st.Verifier, Next: "/projects/acme?tab=1", Intent: OAuthIntentLogin, Remember: true}
		if st != want {
			t.Errorf("stored state = %+v, want %+v", st, want)
		}
		if len(st.Verifier) < 43 || q.Get("code_challenge") != s256(st.Verifier) {
			t.Errorf("code_challenge %q does not match S256(verifier %q)", q.Get("code_challenge"), st.Verifier)
		}
	})

	t.Run("google", func(t *testing.T) {
		resp := api.Get(startPath("google", ""))
		if resp.Code != http.StatusFound {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		loc, err := url.Parse(resp.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(loc.Path, "/o/oauth2/v2/auth") {
			t.Errorf("authorize URL not from discovery: %s", loc)
		}
		q := loc.Query()
		checkParams(t, q, map[string]string{
			"response_type":         "code",
			"client_id":             "g-id",
			"redirect_uri":          "https://id.example.com/api/v1/auth/oauth/google/callback",
			"scope":                 "openid email profile",
			"code_challenge_method": "S256",
		})
		st, err := states.Take(context.Background(), q.Get("state"))
		if err != nil {
			t.Fatalf("state not stored: %v", err)
		}
		if st.Nonce == "" || q.Get("nonce") != st.Nonce {
			t.Errorf("nonce = %q, stored %q", q.Get("nonce"), st.Nonce)
		}
		if q.Get("code_challenge") != s256(st.Verifier) {
			t.Errorf("code_challenge does not match the stored verifier")
		}
		if st.Next != "/" || st.Intent != OAuthIntentLogin || st.Remember {
			t.Errorf("defaults: %+v", st)
		}
	})

	t.Run("fresh state, verifier and nonce per attempt", func(t *testing.T) {
		seen := map[string]bool{}
		for range 3 {
			q := mustLocation(t, api.Get(startPath("google", ""))).Query()
			for _, k := range []string{"state", "nonce", "code_challenge"} {
				if seen[q.Get(k)] {
					t.Fatalf("%s reused: %q", k, q.Get(k))
				}
				seen[q.Get(k)] = true
			}
		}
		states.mu.Lock()
		defer states.mu.Unlock()
		for s, ttl := range states.ttls {
			if ttl != OAuthStateTTL {
				t.Errorf("state %s ttl = %v, want %v", s, ttl, OAuthStateTTL)
			}
		}
	})
}

func checkParams(t *testing.T, q url.Values, want map[string]string) {
	t.Helper()
	for k, v := range want {
		if got := q.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if q.Get("state") == "" || q.Get("code_challenge") == "" {
		t.Errorf("missing state or code_challenge: %v", q)
	}
}

func mustLocation(t *testing.T, resp *httptest.ResponseRecorder) *url.URL {
	t.Helper()
	if resp.Code != http.StatusFound {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	u, err := url.Parse(resp.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestOAuthStartNextValidation(t *testing.T) {
	states := newMemStates()
	api, _ := newTestOAuth(t, testOAuthCfg, states, nil)
	for _, next := range []string{
		"https://evil.com",
		"//evil.com",
		"/\\evil.com",
		"\\\\evil.com",
		"evil.com",
		"javascript:alert(1)",
		"/foo\r\nSet-Cookie: x=1",
		"/a\tb",
		"",
	} {
		resp := api.Get(startPath("github", "next="+url.QueryEscape(next)))
		if next == "" {
			if resp.Code != http.StatusFound {
				t.Errorf("empty next: status = %d", resp.Code)
			}
			continue
		}
		if resp.Code != http.StatusBadRequest {
			t.Errorf("next %q: status = %d, want 400", next, resp.Code)
			continue
		}
		if !strings.Contains(resp.Body.String(), `"code":"invalid_request"`) {
			t.Errorf("next %q: body = %s", next, resp.Body)
		}
	}
	if resp := api.Get(startPath("github", "next=/"+strings.Repeat("a", maxNextLen))); resp.Code != http.StatusUnprocessableEntity && resp.Code != http.StatusBadRequest {
		t.Errorf("over-long next: status = %d", resp.Code)
	}
}

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{
		"":                  "/",
		"/":                 "/",
		"/projects/acme":    "/projects/acme",
		"/a?b=c#d":          "/a?b=c#d",
		"/%2F%2Fevil.com":   "/%2F%2Fevil.com",
		"/settings/account": "/settings/account",
	} {
		if got, ok := SafeNext(in); !ok || got != want {
			t.Errorf("SafeNext(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"//x", "/\\x", "http://x/", "x", "/\x00", "/\x7f", " /x"} {
		if got, ok := SafeNext(in); ok {
			t.Errorf("SafeNext(%q) = %q, accepted", in, got)
		}
	}
}

func TestOAuthStartErrors(t *testing.T) {
	t.Run("disabled provider is 404", func(t *testing.T) {
		cfg := testOAuthCfg
		cfg.OAuth.GitHub = config.OAuthProviderConfig{}
		api, _ := newTestOAuth(t, cfg, newMemStates(), nil)
		if resp := api.Get(startPath("github", "")); resp.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.Code)
		}
	})

	t.Run("unknown provider is rejected", func(t *testing.T) {
		api, _ := newTestOAuth(t, testOAuthCfg, newMemStates(), nil)
		if resp := api.Get(startPath("gitlab", "")); resp.Code < 400 || resp.Code >= 500 {
			t.Fatalf("status = %d, want 4xx", resp.Code)
		}
	})

	t.Run("link without a signed-in user is unauthenticated", func(t *testing.T) {
		api, _ := newTestOAuth(t, testOAuthCfg, newMemStates(), nil)
		resp := api.Get(startPath("github", "intent=link"))
		if resp.Code != http.StatusUnauthorized || !strings.Contains(resp.Body.String(), `"code":"unauthenticated"`) {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
	})

	t.Run("link binds the signed-in user", func(t *testing.T) {
		states := newMemStates()
		api, o := newTestOAuth(t, testOAuthCfg, states, nil)
		o.CurrentUser = func(context.Context) (string, bool) { return "user-1", true }
		q := mustLocation(t, api.Get(startPath("github", "intent=link&next=/settings"))).Query()
		st, err := states.Take(context.Background(), q.Get("state"))
		if err != nil {
			t.Fatal(err)
		}
		if st.Intent != OAuthIntentLink || st.LinkUserID != "user-1" || st.Next != "/settings" {
			t.Fatalf("state = %+v", st)
		}
	})

	t.Run("state store unavailable is 503", func(t *testing.T) {
		api, _ := newTestOAuth(t, testOAuthCfg, NewValkeyOAuthStateStore(nil), nil)
		if resp := api.Get(startPath("github", "")); resp.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", resp.Code)
		}
	})

	t.Run("discovery failure is 500 and retried", func(t *testing.T) {
		api, o := newTestOAuth(t, testOAuthCfg, newMemStates(), nil)
		good := o.Provider("google").issuer
		o.Provider("google").issuer = "http://127.0.0.1:1"
		if resp := api.Get(startPath("google", "")); resp.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", resp.Code)
		}
		o.Provider("google").issuer = good
		mustLocation(t, api.Get(startPath("google", "")))
	})
}

func TestOAuthDiscoveryIsCached(t *testing.T) {
	issuer, hits := fakeGoogle(t)
	p := OAuthProviders(testOAuthCfg)[config.OAuthProviderGoogle]
	p.issuer = issuer
	for range 3 {
		if _, err := p.OAuth2Config(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if *hits != 1 {
		t.Fatalf("discovery fetched %d times, want 1", *hits)
	}
}

func TestOAuthStartIsRateLimitedPerIP(t *testing.T) {
	// With a limit configured and no Valkey, the limiter fails closed: the
	// 503 proves the per-IP limit guards the operation. The 429 path is
	// covered by the integration test against a real Valkey.
	cfg := testOAuthCfg
	cfg.RateLimits.OAuthStartPerIP = config.RateLimit{Limit: 5, Window: time.Minute}
	states := newMemStates()
	api, _ := newTestOAuth(t, cfg, states, nil)
	if resp := api.Get(startPath("github", "")); resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (fail closed)", resp.Code)
	}
	if len(states.m) != 0 {
		t.Fatal("state stored for a refused request")
	}
}

func TestOAuthStartOperation(t *testing.T) {
	_, api := humatest.New(t)
	NewOAuth(config.IdentityConfig{}, newMemStates(), nil, nil).Register(api)
	op := api.OpenAPI().Paths[AuthPrefix+"/oauth/{provider}/start"].Get
	if op == nil {
		t.Fatal("GET /auth/oauth/{provider}/start not registered")
	}
	// Public, with an optional session (intent=link needs it).
	if len(op.Security) != 2 || len(op.Security[0]) != 0 || op.Security[1][authn.SchemeSession] == nil {
		t.Errorf("security = %v, want [{} {session}]", op.Security)
	}
	if _, ok := op.Responses["302"]; !ok {
		t.Errorf("responses = %v, want 302", keys(op.Responses))
	}
	if _, ok := op.Responses["429"]; !ok {
		t.Errorf("responses = %v, want 429", keys(op.Responses))
	}
}

func keys(m map[string]*huma.Response) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
