package oidcprovider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
)

type noKeys struct{}

func (noKeys) Active() (keys.Key, bool) { return keys.Key{}, false }
func (noKeys) All() []keys.Key          { return nil }

func testOptions() Options {
	return Options{
		Issuer: "http://localhost:8080/", PublicUIURL: "http://localhost:3000",
		AccessTokenTTL: 15 * time.Minute, RefreshTokenTTL: time.Hour,
	}
}

func TestNewStorageValidates(t *testing.T) {
	for name, mod := range map[string]func(*Options){
		"no issuer":  func(o *Options) { o.Issuer = "" },
		"bad issuer": func(o *Options) { o.Issuer = "id.example.com" },
		"no ttl":     func(o *Options) { o.AccessTokenTTL = 0 },
		"no refresh": func(o *Options) { o.RefreshTokenTTL = 0 },
	} {
		o := testOptions()
		mod(&o)
		if _, err := NewStorage(nil, noKeys{}, o); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// The provider mounts next to identity's JWKS route on the shared mux and
// serves discovery without touching the database.
func TestMountServesDiscovery(t *testing.T) {
	s, err := NewStorage(nil, noKeys{}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	p, err := New(s)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+defaultJWKSPath, http.NotFoundHandler())
	p.Mount(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, DiscoveryPath, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("discovery = %d %s", rec.Code, rec.Body)
	}
	var d map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d["issuer"] != "http://localhost:8080" || d["jwks_uri"] != "http://localhost:8080/.well-known/jwks.json" ||
		d["token_endpoint"] != "http://localhost:8080/oauth/token" {
		t.Errorf("discovery = %v", d)
	}

	// Provider responses are never cached.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, TokenPath, nil))
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("token Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}

	// An unknown callback error is refused before any lookup.
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, CallbackPath+"?id=x&error=server_error", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("unknown callback error = %d", rec.Code)
	}
}

func TestRegisterClientValidates(t *testing.T) {
	cases := map[string]NewClient{
		"unknown grant":         {RedirectURIs: []string{"https://a.example.com/cb"}, GrantTypes: []string{"password"}},
		"code without redirect": {GrantTypes: []string{"authorization_code"}},
		"refresh alone":         {GrantTypes: []string{"refresh_token", "client_credentials"}},
		"relative redirect":     {RedirectURIs: []string{"/cb"}},
		"fragment redirect":     {RedirectURIs: []string{"https://a.example.com/cb#x"}},
		"public machine":        {Public: true, GrantTypes: []string{"client_credentials"}},
		"public with secret":    {Public: true, AuthMethod: "client_secret_basic", RedirectURIs: []string{"http://127.0.0.1/cb"}},
		"bad auth method":       {AuthMethod: "private_key_jwt", GrantTypes: []string{"client_credentials"}},
	}
	for name, nc := range cases {
		// Validation fails before the (nil) database is used.
		if _, err := RegisterClient(context.Background(), nil, nc); !errors.Is(err, ErrInvalidClient) {
			t.Errorf("%s: err = %v, want ErrInvalidClient", name, err)
		}
	}
}

func TestDeriveCryptoKey(t *testing.T) {
	a := DeriveCryptoKey([]byte("kek-a"))
	if a != DeriveCryptoKey([]byte("kek-a")) {
		t.Error("derivation is not deterministic")
	}
	if a == DeriveCryptoKey([]byte("kek-b")) {
		t.Error("different KEKs derive the same key")
	}
}

func TestHashTokenAndSecret(t *testing.T) {
	h := hashToken("s3cret")
	if len(h) != 64 || h == hashToken("s3cret ") {
		t.Fatalf("hash = %q", h)
	}
	if !checkSecret(dbClient(&h), "s3cret") || checkSecret(dbClient(&h), "wrong") || checkSecret(dbClient(nil), "") {
		t.Error("checkSecret")
	}
}

func dbClient(secretHash *string) db.OauthClient { return db.OauthClient{SecretHash: secretHash} }
