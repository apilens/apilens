//go:build integration

package identity

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/oidcprovider"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/testutil"
)

const (
	opIssuer   = "https://id.example.com"
	opUI       = "https://app.example.com"
	opRedirect = "https://client.example.com/callback"
)

type opClock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (c *opClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.offset)
}

func (c *opClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.offset += d
}

type opFixture struct {
	t        *testing.T
	op       http.Handler
	api      humatest.TestAPI
	q        *db.Queries
	sessions *session.Service
	verifier *authn.SessionVerifier
	key      idkeys.Key
	clock    *opClock
	web      oidcprovider.RegisteredClient // authorization_code + refresh_token
	machine  oidcprovider.RegisteredClient // client_credentials
}

// setupOP serves the OIDC provider and the authorization-request endpoints
// over real Postgres, with the session verifier the api role uses.
func setupOP(t *testing.T) *opFixture {
	t.Helper()
	pool := testutil.MigratedPostgres(t)
	priv, err := rsa.GenerateKey(rand.Reader, idkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k, err := idkeys.Unstored(priv, &now, nil)
	if err != nil {
		t.Fatal(err)
	}
	ks := meKeySet{k}
	issuer, err := token.New(ks, token.Options{Issuer: opIssuer, TTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	logger := testutil.Logger(t)
	sessions, err := session.New(pool, issuer, session.Options{RefreshTTL: time.Hour, RefreshTTLShort: time.Hour}, logger)
	if err != nil {
		t.Fatal(err)
	}
	clock := &opClock{}
	storage, err := oidcprovider.NewStorage(pool, ks, oidcprovider.Options{
		Issuer: opIssuer, PublicUIURL: opUI, AccessTokenTTL: 15 * time.Minute, RefreshTokenTTL: time.Hour,
		CryptoKey: oidcprovider.DeriveCryptoKey([]byte("0123456789abcdef0123456789abcdef")), Now: clock.Now,
	})
	if err != nil {
		t.Fatal(err)
	}
	provider, err := oidcprovider.New(storage)
	if err != nil {
		t.Fatal(err)
	}
	src := authn.KeySourceFunc(func(_ context.Context, kid string) (crypto.PublicKey, error) {
		if kid != k.KID {
			return nil, authn.ErrUnknownKey
		}
		return k.Signer().Public(), nil
	})
	verifier := authn.NewSessionVerifier(src, opIssuer, nil)
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(authn.Middleware(api, verifier))
	NewOIDCRequests(storage, logger).Register(api)

	q := db.New(pool)
	ctx := context.Background()
	web, err := oidcprovider.RegisterClient(ctx, q, oidcprovider.NewClient{
		Name: "Example app", RedirectURIs: []string{opRedirect}, GrantTypes: []string{"authorization_code", "refresh_token"},
	})
	if err != nil {
		t.Fatal(err)
	}
	machine, err := oidcprovider.RegisterClient(ctx, q, oidcprovider.NewClient{Name: "Agent", GrantTypes: []string{"client_credentials"}})
	if err != nil {
		t.Fatal(err)
	}
	return &opFixture{
		t: t, op: provider.Handler(), api: api, q: q, sessions: sessions, verifier: verifier,
		key: k, clock: clock, web: web, machine: machine,
	}
}

func (f *opFixture) do(req *http.Request) *httptest.ResponseRecorder {
	f.t.Helper()
	rec := httptest.NewRecorder()
	f.op.ServeHTTP(rec, req)
	return rec
}

func (f *opFixture) get(target string) *httptest.ResponseRecorder {
	return f.do(httptest.NewRequest(http.MethodGet, target, nil))
}

// tokenRequest posts form to /oauth/token authenticated as c (HTTP Basic).
func (f *opFixture) tokenRequest(c oidcprovider.RegisteredClient, secret string, form url.Values) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, opIssuer+oidcprovider.TokenPath, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(url.QueryEscape(c.ClientID), url.QueryEscape(secret))
	return f.do(req)
}

// signIn creates a user signed in by email and returns its bearer header.
func (f *opFixture) signIn(email string) (db.User, string) {
	f.t.Helper()
	ctx := context.Background()
	verified := time.Now()
	u, err := f.q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: email, EmailVerifiedAt: &verified, Name: "Ada"})
	if err != nil {
		f.t.Fatal(err)
	}
	tok, err := f.sessions.Create(ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		f.t.Fatal(err)
	}
	return u, "Authorization: Bearer " + tok.AccessToken
}

// authorize starts an authorization request and returns its id (from the
// UI login URL identity redirects to).
func (f *opFixture) authorize(params url.Values) string {
	f.t.Helper()
	q := url.Values{
		"client_id": {f.web.ClientID}, "redirect_uri": {opRedirect}, "response_type": {"code"},
		"scope": {"openid email profile offline_access"}, "state": {"st-1"}, "nonce": {"n-1"},
	}
	for k, v := range params {
		q[k] = v
	}
	rec := f.get(opIssuer + oidcprovider.AuthorizePath + "?" + q.Encode())
	if rec.Code != http.StatusFound {
		f.t.Fatalf("authorize = %d %s", rec.Code, rec.Body)
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		f.t.Fatal(err)
	}
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != opUI+oidcprovider.LoginPath {
		f.t.Fatalf("login redirect = %s, want the UI sign-in", loc)
	}
	return loc.Query().Get("request_id")
}

// complete signs the user in to request id through the API and follows the
// callback, returning the client redirect's query.
func (f *opFixture) complete(id, auth string) url.Values {
	f.t.Helper()
	resp := f.api.Post(OIDCRequestsPath[:len(OIDCRequestsPath)-len("{id}")]+id+"/complete", auth)
	if resp.Code != http.StatusOK {
		f.t.Fatalf("complete = %d %s", resp.Code, resp.Body)
	}
	var out struct {
		RedirectTo string `json:"redirect_to"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		f.t.Fatal(err)
	}
	if !strings.HasPrefix(out.RedirectTo, opIssuer+oidcprovider.CallbackPath+"?") {
		f.t.Fatalf("redirect_to = %q", out.RedirectTo)
	}
	return f.followCallback(out.RedirectTo)
}

func (f *opFixture) followCallback(target string) url.Values {
	f.t.Helper()
	rec := f.get(target)
	if rec.Code != http.StatusFound {
		f.t.Fatalf("callback = %d %s", rec.Code, rec.Body)
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		f.t.Fatal(err)
	}
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != opRedirect {
		f.t.Fatalf("client redirect = %s", loc)
	}
	return loc.Query()
}

func pkce() (verifier, challenge string) {
	verifier = base64.RawURLEncoding.EncodeToString([]byte(uuid.NewString() + uuid.NewString()))
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
}

func decodeToken(t *testing.T, rec *httptest.ResponseRecorder) tokenResponse {
	t.Helper()
	var tr tokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &tr); err != nil {
		t.Fatalf("token response %d: %v: %s", rec.Code, err, rec.Body)
	}
	return tr
}

// parse verifies raw with the provider key and returns its claims.
func (f *opFixture) parse(raw string) jwt.MapClaims {
	f.t.Helper()
	claims := jwt.MapClaims{}
	tok, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if t.Header["kid"] != f.key.KID {
			f.t.Errorf("kid = %v, want %s", t.Header["kid"], f.key.KID)
		}
		return f.key.Signer().Public(), nil
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(opIssuer))
	if err != nil || !tok.Valid {
		f.t.Fatalf("token does not verify: %v", err)
	}
	return claims
}

func TestOIDCProviderDiscovery(t *testing.T) {
	f := setupOP(t)
	rec := f.get(opIssuer + oidcprovider.DiscoveryPath)
	if rec.Code != http.StatusOK {
		t.Fatalf("discovery = %d", rec.Code)
	}
	var d struct {
		Issuer            string   `json:"issuer"`
		Authorization     string   `json:"authorization_endpoint"`
		Token             string   `json:"token_endpoint"`
		Userinfo          string   `json:"userinfo_endpoint"`
		JWKS              string   `json:"jwks_uri"`
		Grants            []string `json:"grant_types_supported"`
		Scopes            []string `json:"scopes_supported"`
		Algs              []string `json:"id_token_signing_alg_values_supported"`
		PKCE              []string `json:"code_challenge_methods_supported"`
		TokenAuthMethods  []string `json:"token_endpoint_auth_methods_supported"`
		SubjectTypes      []string `json:"subject_types_supported"`
		ResponseTypesSupp []string `json:"response_types_supported"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Issuer != opIssuer || d.Authorization != opIssuer+"/oauth/authorize" || d.Token != opIssuer+"/oauth/token" ||
		d.Userinfo != opIssuer+"/oauth/userinfo" || d.JWKS != opIssuer+"/.well-known/jwks.json" {
		t.Errorf("endpoints = %+v", d)
	}
	for _, g := range []string{"authorization_code", "refresh_token", "client_credentials"} {
		if !slices.Contains(d.Grants, g) {
			t.Errorf("grant_types_supported %v lacks %s", d.Grants, g)
		}
	}
	if !slices.Equal(d.Algs, []string{"RS256"}) || !slices.Contains(d.PKCE, "S256") || !slices.Contains(d.Scopes, "openid") ||
		!slices.Contains(d.TokenAuthMethods, "client_secret_basic") || !slices.Contains(d.TokenAuthMethods, "client_secret_post") {
		t.Errorf("discovery = %+v", d)
	}
}

func TestOIDCProviderAuthorizationCodeFlow(t *testing.T) {
	f := setupOP(t)
	user, auth := f.signIn("ada@example.com")
	verifier, challenge := pkce()

	id := f.authorize(url.Values{"code_challenge": {challenge}, "code_challenge_method": {"S256"}})

	// The UI reads the request before signing in.
	resp := f.api.Get(OIDCRequestsPath[:len(OIDCRequestsPath)-len("{id}")] + id)
	if resp.Code != http.StatusOK {
		t.Fatalf("get request = %d %s", resp.Code, resp.Body)
	}
	var info OIDCRequest
	if err := json.Unmarshal(resp.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.ClientID != f.web.ClientID || info.ClientName != "Example app" || !slices.Contains(info.Scopes, "email") ||
		info.CallbackURL != opIssuer+oidcprovider.CallbackPath+"?id="+id {
		t.Errorf("request = %+v", info)
	}
	// Completing needs a session.
	if resp := f.api.Post(OIDCRequestsPath[:len(OIDCRequestsPath)-len("{id}")] + id + "/complete"); resp.Code != http.StatusUnauthorized {
		t.Errorf("complete without session = %d", resp.Code)
	}

	cb := f.complete(id, auth)
	code := cb.Get("code")
	if code == "" || cb.Get("state") != "st-1" {
		t.Fatalf("callback query = %v", cb)
	}
	// The callback issues one code per request.
	if rec := f.get(info.CallbackURL); rec.Code == http.StatusFound && strings.Contains(rec.Header().Get("Location"), "code=") {
		t.Error("a replayed callback issued a second code")
	}

	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {opRedirect}}
	// PKCE is enforced.
	if rec := f.tokenRequest(f.web, f.web.ClientSecret, withValue(form, "code_verifier", "wrong-verifier-wrong-verifier-wrong-verifier")); rec.Code == http.StatusOK {
		t.Fatal("a wrong code_verifier was accepted")
	}
	// The failed attempt burned the code; start over.
	id = f.authorize(url.Values{"code_challenge": {challenge}, "code_challenge_method": {"S256"}})
	code = f.complete(id, auth).Get("code")
	form.Set("code", code)

	// A wrong client secret is refused.
	if rec := f.tokenRequest(f.web, "nope", withValue(form, "code_verifier", verifier)); rec.Code != http.StatusUnauthorized && rec.Code != http.StatusBadRequest {
		t.Errorf("wrong secret = %d", rec.Code)
	}
	id = f.authorize(url.Values{"code_challenge": {challenge}, "code_challenge_method": {"S256"}})
	code = f.complete(id, auth).Get("code")
	form.Set("code", code)

	rec := f.tokenRequest(f.web, f.web.ClientSecret, withValue(form, "code_verifier", verifier))
	if rec.Code != http.StatusOK {
		t.Fatalf("token = %d %s", rec.Code, rec.Body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("token Cache-Control = %q", cc)
	}
	tr := decodeToken(t, rec)
	if tr.AccessToken == "" || tr.IDToken == "" || tr.RefreshToken == "" || !strings.EqualFold(tr.TokenType, "bearer") {
		t.Fatalf("token response = %+v", tr)
	}

	idc := f.parse(tr.IDToken)
	if idc["sub"] != user.ID.String() || idc["nonce"] != "n-1" || idc["auth_time"] == nil {
		t.Errorf("id token claims = %v", idc)
	}
	if aud, _ := idc.GetAudience(); !slices.Contains(aud, f.web.ClientID) || slices.Contains(aud, authn.Audience) {
		t.Errorf("id token aud = %v", aud)
	}
	atc := f.parse(tr.AccessToken)
	if atc["sub"] != user.ID.String() || atc["client_id"] != f.web.ClientID {
		t.Errorf("access token claims = %v", atc)
	}
	// A token held on a user's behalf is not an API credential.
	if _, err := f.verifier.Verify(context.Background(), tr.AccessToken); err == nil {
		t.Error("the api verifier accepted a delegated access token")
	}

	// The code works once.
	if rec := f.tokenRequest(f.web, f.web.ClientSecret, withValue(form, "code_verifier", verifier)); rec.Code == http.StatusOK {
		t.Error("an authorization code was redeemed twice")
	}

	// userinfo releases the claims of the granted scopes.
	ui := f.userinfo(tr.AccessToken)
	if ui.Code != http.StatusOK {
		t.Fatalf("userinfo = %d %s", ui.Code, ui.Body)
	}
	var claims map[string]any
	if err := json.Unmarshal(ui.Body.Bytes(), &claims); err != nil {
		t.Fatal(err)
	}
	if claims["sub"] != user.ID.String() || claims["email"] != "ada@example.com" || claims["email_verified"] != true || claims["name"] != "Ada" {
		t.Errorf("userinfo = %v", claims)
	}

	// Refreshing rotates the refresh token.
	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tr.RefreshToken}}
	rec = f.tokenRequest(f.web, f.web.ClientSecret, refresh)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh = %d %s", rec.Code, rec.Body)
	}
	rotated := decodeToken(t, rec)
	if rotated.AccessToken == "" || rotated.RefreshToken == "" || rotated.RefreshToken == tr.RefreshToken {
		t.Fatalf("refresh response = %+v", rotated)
	}
	if rec := f.tokenRequest(f.web, f.web.ClientSecret, refresh); rec.Code == http.StatusOK {
		t.Error("a rotated refresh token was accepted again")
	}
	if rec := f.tokenRequest(f.machine, f.machine.ClientSecret, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rotated.RefreshToken}}); rec.Code == http.StatusOK {
		t.Error("another client redeemed the refresh token")
	}

	// Revoking the access token ends userinfo for it.
	rev := httptest.NewRequest(http.MethodPost, opIssuer+oidcprovider.RevokePath, strings.NewReader(url.Values{"token": {rotated.AccessToken}}.Encode()))
	rev.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rev.SetBasicAuth(f.web.ClientID, f.web.ClientSecret)
	if rec := f.do(rev); rec.Code != http.StatusOK {
		t.Fatalf("revoke = %d %s", rec.Code, rec.Body)
	}
	if ui := f.userinfo(rotated.AccessToken); ui.Code == http.StatusOK {
		t.Error("userinfo accepted a revoked access token")
	}
}

func (f *opFixture) userinfo(access string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, opIssuer+oidcprovider.UserinfoPath, nil)
	req.Header.Set("Authorization", "Bearer "+access)
	return f.do(req)
}

func withValue(v url.Values, k, val string) url.Values {
	out := url.Values{}
	for key, vals := range v {
		out[key] = slices.Clone(vals)
	}
	out.Set(k, val)
	return out
}

// Acceptance (#301): a client_credentials token is accepted by the api JWT
// verifier with sub = the client.
func TestOIDCProviderClientCredentials(t *testing.T) {
	f := setupOP(t)
	form := url.Values{"grant_type": {"client_credentials"}, "scope": {"anything"}}

	rec := f.tokenRequest(f.machine, f.machine.ClientSecret, form)
	if rec.Code != http.StatusOK {
		t.Fatalf("token = %d %s", rec.Code, rec.Body)
	}
	tr := decodeToken(t, rec)
	if tr.AccessToken == "" || tr.RefreshToken != "" || tr.IDToken != "" {
		t.Fatalf("token response = %+v", tr)
	}
	p, err := f.verifier.Verify(context.Background(), tr.AccessToken)
	if err != nil {
		t.Fatalf("api verifier rejected the client token: %v", err)
	}
	if p.Kind != authn.KindClient || p.ClientID != f.machine.ClientID {
		t.Errorf("principal = %+v", p)
	}
	if c := f.parse(tr.AccessToken); c["sub"] != f.machine.ClientID {
		t.Errorf("sub = %v, want the client", c["sub"])
	}

	// Client secret sent in the body works too.
	post := httptest.NewRequest(http.MethodPost, opIssuer+oidcprovider.TokenPath, strings.NewReader(url.Values{
		"grant_type": {"client_credentials"}, "client_id": {f.machine.ClientID}, "client_secret": {f.machine.ClientSecret},
	}.Encode()))
	post.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if rec := f.do(post); rec.Code != http.StatusOK {
		t.Errorf("client_secret_post = %d %s", rec.Code, rec.Body)
	}

	for name, c := range map[string]struct {
		client oidcprovider.RegisteredClient
		secret string
	}{
		"wrong secret":         {f.machine, "wrong"},
		"grant not registered": {f.web, f.web.ClientSecret},
		"unknown client":       {oidcprovider.RegisteredClient{ClientID: "nobody"}, "x"},
	} {
		if rec := f.tokenRequest(c.client, c.secret, form); rec.Code == http.StatusOK {
			t.Errorf("%s: token issued", name)
		}
	}
}

func TestOIDCProviderPromptNoneAndMaxAge(t *testing.T) {
	f := setupOP(t)
	_, auth := f.signIn("grace@example.com")

	// prompt=none without a UI session: the UI ends the request.
	id := f.authorize(url.Values{"prompt": {"none"}})
	cb := f.followCallback(opIssuer + oidcprovider.CallbackPath + "?id=" + id + "&error=login_required")
	if cb.Get("error") != "login_required" || cb.Get("state") != "st-1" {
		t.Errorf("callback = %v", cb)
	}
	if resp := f.api.Post(OIDCRequestsPath[:len(OIDCRequestsPath)-len("{id}")]+id+"/complete", auth); resp.Code != http.StatusBadRequest {
		t.Errorf("complete after error = %d, want 400", resp.Code)
	}

	// max_age shorter than the session's age needs a new sign-in.
	id = f.authorize(url.Values{"max_age": {"60"}})
	f.clock.advance(5 * time.Minute)
	resp := f.api.Post(OIDCRequestsPath[:len(OIDCRequestsPath)-len("{id}")]+id+"/complete", auth)
	if resp.Code != http.StatusForbidden || !strings.Contains(resp.Body.String(), string(CodeReauthRequired)) {
		t.Errorf("stale session = %d %s", resp.Code, resp.Body)
	}

	// Plain PKCE is refused.
	q := url.Values{
		"client_id": {f.web.ClientID}, "redirect_uri": {opRedirect}, "response_type": {"code"}, "scope": {"openid"},
		"code_challenge": {"abc"}, "code_challenge_method": {"plain"}, "state": {"s"},
	}
	rec := f.get(opIssuer + oidcprovider.AuthorizePath + "?" + q.Encode())
	if loc := rec.Header().Get("Location"); !strings.Contains(loc, "error=invalid_request") {
		t.Errorf("plain PKCE = %d %s", rec.Code, loc)
	}

	// An unregistered redirect URI is never redirected to.
	q.Set("redirect_uri", "https://evil.example.com/cb")
	q.Del("code_challenge")
	q.Del("code_challenge_method")
	rec = f.get(opIssuer + oidcprovider.AuthorizePath + "?" + q.Encode())
	if rec.Code == http.StatusFound && strings.HasPrefix(rec.Header().Get("Location"), "https://evil.example.com") {
		t.Error("redirected to an unregistered redirect_uri")
	}
}
