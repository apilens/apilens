package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
)

// fakeIdP plays both providers for callback tests: Google as an OIDC issuer
// (discovery, JWKS, token endpoint signing id_tokens) and GitHub (token
// endpoint, /user, /user/emails) under /gh. A test grants an authorization
// code with Grant; the token endpoints redeem it once, checking the PKCE
// verifier against the challenge the start redirect carried.
type fakeIdP struct {
	srv *httptest.Server
	key *rsa.PrivateKey

	mu         sync.Mutex
	grants     map[string]idpGrant // by authorization code
	access     map[string]idpGrant // by access token
	tokenCalls int
}

// idpGrant is what one authorization code yields.
type idpGrant struct {
	// challenge is the PKCE S256 challenge the code was issued for.
	challenge string
	// claims are the Google id_token claims; iss, aud, iat and exp default
	// to valid values.
	claims map[string]any
	// ghUser and ghEmails answer GitHub's /user and /user/emails.
	ghUser   githubUser
	ghEmails []githubEmail
}

const idpKID = "test-key"

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIdP{key: key, grants: map[string]idpGrant{}, access: map[string]idpGrant{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"issuer":                                f.srv.URL,
			"authorization_endpoint":                f.srv.URL + "/authorize",
			"token_endpoint":                        f.srv.URL + "/token",
			"jwks_uri":                              f.srv.URL + "/certs",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("GET /certs", func(w http.ResponseWriter, _ *http.Request) {
		pub := f.key.PublicKey
		writeJSON(w, http.StatusOK, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": idpKID, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) { f.token(t, w, r, true) })
	mux.HandleFunc("POST /gh/token", func(w http.ResponseWriter, r *http.Request) { f.token(t, w, r, false) })
	mux.HandleFunc("GET /gh/api/user", func(w http.ResponseWriter, r *http.Request) {
		if g, ok := f.bearer(r); ok {
			writeJSON(w, http.StatusOK, g.ghUser)
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
	})
	mux.HandleFunc("GET /gh/api/user/emails", func(w http.ResponseWriter, r *http.Request) {
		if g, ok := f.bearer(r); ok {
			writeJSON(w, http.StatusOK, g.ghEmails)
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"message": "Bad credentials"})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

// Use points o's providers at the fake.
func (f *fakeIdP) Use(o *OAuth) {
	if g := o.providers["google"]; g != nil {
		g.issuer = f.srv.URL
	}
	if gh := o.providers["github"]; gh != nil {
		gh.config.Endpoint = oauth2.Endpoint{AuthURL: f.srv.URL + "/gh/authorize", TokenURL: f.srv.URL + "/gh/token"}
		gh.apiURL = f.srv.URL + "/gh/api"
	}
}

// Grant issues an authorization code for g.
func (f *fakeIdP) Grant(code string, g idpGrant) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.grants[code] = g
}

func (f *fakeIdP) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tokenCalls
}

func (f *fakeIdP) token(t *testing.T, w http.ResponseWriter, r *http.Request, oidc bool) {
	if err := r.ParseForm(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	f.mu.Lock()
	f.tokenCalls++
	code := r.PostForm.Get("code")
	g, ok := f.grants[code]
	delete(f.grants, code)
	f.mu.Unlock()
	if !ok || r.PostForm.Get("grant_type") != "authorization_code" || s256(r.PostForm.Get("code_verifier")) != g.challenge {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
		return
	}
	at := "at-" + code
	f.mu.Lock()
	f.access[at] = g
	f.mu.Unlock()
	body := map[string]any{"access_token": at, "token_type": "Bearer", "expires_in": 3600}
	if oidc {
		now := time.Now()
		claims := jwt.MapClaims{"iss": f.srv.URL, "aud": "g-id", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
		for k, v := range g.claims {
			claims[k] = v
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = idpKID
		raw, err := tok.SignedString(f.key)
		if err != nil {
			t.Error(err)
		}
		body["id_token"] = raw
	}
	writeJSON(w, http.StatusOK, body)
}

func (f *fakeIdP) bearer(r *http.Request) (idpGrant, bool) {
	at, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return idpGrant{}, false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	g, ok := f.access[at]
	return g, ok
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// startedFlow is what the start redirect handed the provider.
type startedFlow struct {
	state, challenge, nonce string
}

// beginOAuth runs GET …/start and returns the state, PKCE challenge and
// nonce the browser carries to the provider.
func beginOAuth(t *testing.T, api humatest.TestAPI, provider, query string) startedFlow {
	t.Helper()
	q := mustLocation(t, api.Get(startPath(provider, query))).Query()
	return startedFlow{state: q.Get("state"), challenge: q.Get("code_challenge"), nonce: q.Get("nonce")}
}

func callbackPath(provider string, q url.Values) string {
	return AuthPrefix + "/oauth/" + provider + "/callback?" + q.Encode()
}
