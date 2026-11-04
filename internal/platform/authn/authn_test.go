package authn

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/go-jose/go-jose/v4"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const testIssuer = "https://id.example.com"

type signingKey struct {
	kid  string
	priv *rsa.PrivateKey
}

func newSigningKey(t *testing.T, kid string) signingKey {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return signingKey{kid: kid, priv: priv}
}

// jwksServer serves the public halves of the keys it holds; set swaps them
// (a rotation) and down makes it fail.
type jwksServer struct {
	*httptest.Server
	mu    sync.Mutex
	keys  []signingKey
	down  bool
	calls atomic.Int32
}

func newJWKSServer(t *testing.T, keys ...signingKey) *jwksServer {
	t.Helper()
	s := &jwksServer{keys: keys}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.calls.Add(1)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.down {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		var set jose.JSONWebKeySet
		for _, k := range s.keys {
			set.Keys = append(set.Keys, jose.JSONWebKey{Key: &k.priv.PublicKey, KeyID: k.kid, Algorithm: "RS256", Use: "sig"})
		}
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *jwksServer) set(keys ...signingKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys = keys
}

func (s *jwksServer) setDown(down bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down = down
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newClock() *clock { return &clock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)} }

type tokenOpts struct {
	issuer string
	aud    string
	sub    string
	sid    string
	amr    []string
	iat    time.Time
	ttl    time.Duration
}

func sign(t *testing.T, k signingKey, now time.Time, mod func(*tokenOpts)) string {
	t.Helper()
	o := tokenOpts{issuer: testIssuer, aud: Audience, sub: uuid.NewString(), sid: uuid.NewString(), amr: []string{"email"}, iat: now, ttl: 15 * time.Minute}
	if mod != nil {
		mod(&o)
	}
	c := claims{
		SessionID: o.sid,
		AMR:       o.amr,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    o.issuer,
			Subject:   o.sub,
			Audience:  jwt.ClaimStrings{o.aud},
			IssuedAt:  jwt.NewNumericDate(o.iat),
			ExpiresAt: jwt.NewNumericDate(o.iat.Add(o.ttl)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, c)
	tok.Header["kid"] = k.kid
	raw, err := tok.SignedString(k.priv)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func newVerifier(srv *jwksServer, clk *clock) (*SessionVerifier, *JWKS) {
	jwks := NewJWKS(srv.URL, JWKSOptions{Client: srv.Client(), Now: clk.Now})
	return NewSessionVerifier(jwks, testIssuer, clk.Now), jwks
}

func TestVerifyValid(t *testing.T) {
	k := newSigningKey(t, "k1")
	srv := newJWKSServer(t, k)
	clk := newClock()
	v, _ := newVerifier(srv, clk)

	user, session := uuid.New(), uuid.New()
	raw := sign(t, k, clk.Now(), func(o *tokenOpts) {
		o.sub, o.sid, o.amr = user.String(), session.String(), []string{"google", "totp"}
	})
	p, err := v.Verify(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Kind != KindUser || p.UserID != user || p.SessionID != session || len(p.AMR) != 2 || p.AMR[0] != "google" {
		t.Errorf("principal = %+v", p)
	}
	// A second token with the same kid is served from cache.
	if _, err := v.Verify(context.Background(), sign(t, k, clk.Now(), nil)); err != nil {
		t.Fatal(err)
	}
	if n := srv.calls.Load(); n != 1 {
		t.Errorf("jwks fetched %d times, want 1", n)
	}
}

func TestVerifyRejects(t *testing.T) {
	k := newSigningKey(t, "k1")
	other := newSigningKey(t, "k1") // same kid, different key: tampered
	srv := newJWKSServer(t, k)
	clk := newClock()
	v, _ := newVerifier(srv, clk)
	now := clk.Now()

	cases := map[string]struct {
		raw  string
		want error
	}{
		"expired":     {sign(t, k, now, func(o *tokenOpts) { o.iat = now.Add(-time.Hour) }), ErrExpired},
		"wrong aud":   {sign(t, k, now, func(o *tokenOpts) { o.aud = "someone-else" }), ErrInvalidToken},
		"wrong iss":   {sign(t, k, now, func(o *tokenOpts) { o.issuer = "https://evil.example.com" }), ErrInvalidToken},
		"bad sig":     {sign(t, other, now, nil), ErrInvalidToken},
		"no sid":      {sign(t, k, now, func(o *tokenOpts) { o.sid = "" }), ErrInvalidToken},
		"bad sub":     {sign(t, k, now, func(o *tokenOpts) { o.sub = "ada" }), ErrInvalidToken},
		"no amr":      {sign(t, k, now, func(o *tokenOpts) { o.amr = nil }), ErrInvalidToken},
		"unknown kid": {sign(t, newSigningKey(t, "k9"), now, nil), ErrInvalidToken},
		"garbage":     {"a.b.c", ErrInvalidToken},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := v.Verify(context.Background(), tc.raw); !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestVerifyRotatedKey(t *testing.T) {
	k1, k2 := newSigningKey(t, "k1"), newSigningKey(t, "k2")
	srv := newJWKSServer(t, k1)
	clk := newClock()
	v, _ := newVerifier(srv, clk)
	ctx := context.Background()

	if _, err := v.Verify(ctx, sign(t, k1, clk.Now(), nil)); err != nil {
		t.Fatal(err)
	}
	// identity rotates: k2 signs, k1 stays published while retired.
	srv.set(k2, k1)

	// Within MinRefresh an unknown kid does not refetch.
	clk.advance(30 * time.Second)
	if _, err := v.Verify(ctx, sign(t, k2, clk.Now(), nil)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("before min refresh: err = %v", err)
	}
	if n := srv.calls.Load(); n != 1 {
		t.Fatalf("jwks fetched %d times within min refresh, want 1", n)
	}

	// After MinRefresh the unknown kid triggers a refetch.
	clk.advance(31 * time.Second)
	if _, err := v.Verify(ctx, sign(t, k2, clk.Now(), nil)); err != nil {
		t.Fatalf("after rotation: %v", err)
	}
	if _, err := v.Verify(ctx, sign(t, k1, clk.Now(), nil)); err != nil {
		t.Fatalf("retired key: %v", err)
	}
	if n := srv.calls.Load(); n != 2 {
		t.Errorf("jwks fetched %d times, want 2", n)
	}
}

func TestVerifyUnreachableJWKS(t *testing.T) {
	k := newSigningKey(t, "k1")
	srv := newJWKSServer(t, k)
	srv.setDown(true)
	clk := newClock()
	v, _ := newVerifier(srv, clk)
	ctx := context.Background()

	// Cold cache and unreachable JWKS: fail closed.
	if _, err := v.Verify(ctx, sign(t, k, clk.Now(), nil)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("cold cache: err = %v, want ErrUnavailable", err)
	}
	// Retries are rate limited.
	if _, err := v.Verify(ctx, sign(t, k, clk.Now(), nil)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("retry: err = %v", err)
	}
	if n := srv.calls.Load(); n != 1 {
		t.Fatalf("jwks fetched %d times, want 1", n)
	}

	// identity comes back: the next allowed fetch fills the cache.
	srv.setDown(false)
	clk.advance(6 * time.Second)
	if _, err := v.Verify(ctx, sign(t, k, clk.Now(), nil)); err != nil {
		t.Fatalf("recovered: %v", err)
	}

	// identity goes away again: cached keys keep verifying past MaxAge.
	srv.setDown(true)
	clk.advance(10 * time.Minute)
	if _, err := v.Verify(ctx, sign(t, k, clk.Now(), nil)); err != nil {
		t.Fatalf("warm cache, jwks down: %v", err)
	}
}

func TestVerifyUnreachableHost(t *testing.T) {
	srv := newJWKSServer(t)
	srv.Close() // connection refused
	clk := newClock()
	v, _ := newVerifier(srv, clk)
	if _, err := v.Verify(context.Background(), sign(t, newSigningKey(t, "k1"), clk.Now(), nil)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

type whoami struct {
	Body struct {
		User string `json:"user"`
	}
}

func TestMiddleware(t *testing.T) {
	k := newSigningKey(t, "k1")
	srv := newJWKSServer(t, k)
	clk := newClock()
	user := uuid.New()
	valid := sign(t, k, clk.Now(), func(o *tokenOpts) { o.sub = user.String() })
	expired := sign(t, k, clk.Now().Add(-time.Hour), nil)

	down := newJWKSServer(t)
	down.setDown(true)

	cases := map[string]struct {
		jwks   *jwksServer
		path   string
		header string
		code   int
	}{
		"valid":                {srv, "/me", "Bearer " + valid, http.StatusOK},
		"missing":              {srv, "/me", "", http.StatusUnauthorized},
		"api key on session":   {srv, "/me", "Bearer apl_live_abc", http.StatusUnauthorized},
		"expired":              {srv, "/me", "Bearer " + expired, http.StatusUnauthorized},
		"basic":                {srv, "/me", "Basic " + valid, http.StatusUnauthorized},
		"jwks down":            {down, "/me", "Bearer " + valid, http.StatusServiceUnavailable},
		"either, session":      {srv, "/either", "Bearer " + valid, http.StatusOK},
		"either, key passes":   {srv, "/either", "Bearer apl_live_abc", http.StatusOK},
		"either, bad jwt":      {srv, "/either", "Bearer " + expired, http.StatusUnauthorized},
		"public":               {srv, "/open", "", http.StatusOK},
		"other scheme only op": {srv, "/key", "Bearer " + valid, http.StatusOK},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, api := humatest.New(t)
			AddSecurityScheme(api)
			v, _ := newVerifier(tc.jwks, clk)
			api.UseMiddleware(Middleware(api, v))
			handler := func(ctx context.Context, _ *struct{}) (*whoami, error) {
				out := &whoami{}
				if p, ok := FromContext(ctx); ok {
					out.Body.User = p.UserID.String()
				}
				return out, nil
			}
			session := []map[string][]string{{SchemeSession: {}}}
			huma.Register(api, huma.Operation{OperationID: "me", Method: http.MethodGet, Path: "/me", Security: session}, handler)
			huma.Register(api, huma.Operation{OperationID: "either", Method: http.MethodGet, Path: "/either",
				Security: []map[string][]string{{SchemeSession: {}}, {"apiKey": {}}}}, handler)
			huma.Register(api, huma.Operation{OperationID: "key", Method: http.MethodGet, Path: "/key",
				Security: []map[string][]string{{"apiKey": {}}}}, handler)
			huma.Register(api, huma.Operation{OperationID: "open", Method: http.MethodGet, Path: "/open"}, handler)

			var args []any
			if tc.header != "" {
				args = append(args, "Authorization: "+tc.header)
			}
			res := api.Get(tc.path, args...).Result()
			defer func() { _ = res.Body.Close() }()
			if res.StatusCode != tc.code {
				t.Fatalf("status = %d, want %d", res.StatusCode, tc.code)
			}
			if res.StatusCode == http.StatusUnauthorized && res.Header.Get("WWW-Authenticate") == "" {
				t.Error("401 without WWW-Authenticate")
			}
			if res.StatusCode == http.StatusOK {
				var body struct{ User string }
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				// Only operations declaring the session scheme with a JWT get a user.
				wantUser := tc.header == "Bearer "+valid && tc.path != "/key"
				if wantUser != (body.User == user.String()) {
					t.Errorf("user = %q, want user set: %t", body.User, wantUser)
				}
			}
		})
	}
}

func TestSecurityScheme(t *testing.T) {
	_, api := humatest.New(t)
	AddSecurityScheme(api)
	s := api.OpenAPI().Components.SecuritySchemes[SchemeSession]
	if s == nil || s.Type != "http" || s.Scheme != "bearer" || s.BearerFormat != "JWT" {
		t.Fatalf("scheme = %+v", s)
	}
}
