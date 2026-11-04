package identity

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"

	signingkeys "github.com/apilens/apilens/internal/identity/keys"
)

type staticKeys []signingkeys.Key

func (s staticKeys) All() []signingkeys.Key { return s }

// testKey builds a published key whose stored JWK is rendered by go-jose
// from material (the public key, or the private key to simulate a stored
// JWK that wrongly carries private members).
func testKey(t *testing.T, priv *rsa.PrivateKey, material any, active bool) signingkeys.Key {
	t.Helper()
	kid := signingkeys.Thumbprint(&priv.PublicKey)
	jwk, err := json.Marshal(jose.JSONWebKey{Key: material, KeyID: kid, Algorithm: signingkeys.AlgRS256, Use: "sig"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k := signingkeys.Key{KID: kid, Alg: signingkeys.AlgRS256, PublicJWK: jwk, CreatedAt: now, ActivatedAt: &now}
	if !active {
		k.RetiredAt = &now
	}
	return k
}

func newRSA(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, signingkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	return priv
}

func serveJWKS(t *testing.T, src KeySource, method string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	RegisterJWKS(mux, src, slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := httptest.NewRequest(method, JWKSPath, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestJWKSServesActiveAndRetiredPublicKeys(t *testing.T) {
	activePriv, retiredPriv := newRSA(t), newRSA(t)
	src := staticKeys{
		testKey(t, activePriv, &activePriv.PublicKey, true),
		// A stored JWK carrying private members must still be served public-only.
		testKey(t, retiredPriv, retiredPriv, false),
	}

	rec := serveJWKS(t, src, http.MethodGet, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if rec.Header().Get("ETag") == "" {
		t.Error("missing ETag")
	}

	var set jose.JSONWebKeySet
	if err := json.Unmarshal(rec.Body.Bytes(), &set); err != nil {
		t.Fatalf("not a JWK set: %v\n%s", err, rec.Body)
	}
	if len(set.Keys) != 2 {
		t.Fatalf("keys = %d, want 2", len(set.Keys))
	}
	for i, priv := range []*rsa.PrivateKey{activePriv, retiredPriv} {
		k := set.Keys[i]
		if !k.Valid() || !k.IsPublic() {
			t.Errorf("key %d: valid=%t public=%t", i, k.Valid(), k.IsPublic())
		}
		if k.KeyID != signingkeys.Thumbprint(&priv.PublicKey) || k.Algorithm != signingkeys.AlgRS256 || k.Use != "sig" {
			t.Errorf("key %d: kid=%q alg=%q use=%q", i, k.KeyID, k.Algorithm, k.Use)
		}
		pub, ok := k.Key.(*rsa.PublicKey)
		if !ok || !pub.Equal(&priv.PublicKey) {
			t.Errorf("key %d: public key does not match", i)
		}
	}

	var raw struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for i, k := range raw.Keys {
		for _, member := range []string{"d", "p", "q", "dp", "dq", "qi", "oth", "k"} {
			if _, ok := k[member]; ok {
				t.Errorf("key %d leaks private member %q", i, member)
			}
		}
	}
}

func TestJWKSEmptySet(t *testing.T) {
	rec := serveJWKS(t, staticKeys(nil), http.MethodGet, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := bytes.TrimSpace(rec.Body.Bytes()); string(got) != `{"keys":[]}` {
		t.Fatalf("body = %s", got)
	}
}

func TestJWKSConditionalRequests(t *testing.T) {
	priv := newRSA(t)
	src := staticKeys{testKey(t, priv, &priv.PublicKey, true)}
	etag := serveJWKS(t, src, http.MethodGet, nil).Header().Get("ETag")

	if again := serveJWKS(t, src, http.MethodGet, nil).Header().Get("ETag"); again != etag {
		t.Fatalf("ETag not stable: %q then %q", etag, again)
	}
	for _, inm := range []string{etag, "W/" + etag, `"other", ` + etag, "*"} {
		rec := serveJWKS(t, src, http.MethodGet, http.Header{"If-None-Match": {inm}})
		if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
			t.Errorf("If-None-Match %s: status = %d, body %d bytes", inm, rec.Code, rec.Body.Len())
		}
		if rec.Header().Get("ETag") != etag || rec.Header().Get("Cache-Control") == "" {
			t.Errorf("If-None-Match %s: 304 lacks ETag/Cache-Control", inm)
		}
	}
	if rec := serveJWKS(t, src, http.MethodGet, http.Header{"If-None-Match": {`"stale"`}}); rec.Code != http.StatusOK {
		t.Errorf("stale If-None-Match: status = %d", rec.Code)
	}

	// A rotation changes the set and so the ETag.
	other := newRSA(t)
	rotated := append(staticKeys{testKey(t, other, &other.PublicKey, true)}, src...)
	if rec := serveJWKS(t, rotated, http.MethodGet, http.Header{"If-None-Match": {etag}}); rec.Code != http.StatusOK || rec.Header().Get("ETag") == etag {
		t.Errorf("after rotation: status = %d, ETag %q", rec.Code, rec.Header().Get("ETag"))
	}
}

func TestJWKSHead(t *testing.T) {
	priv := newRSA(t)
	rec := serveJWKS(t, staticKeys{testKey(t, priv, &priv.PublicKey, true)}, http.MethodHead, nil)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD: status = %d, body %d bytes", rec.Code, rec.Body.Len())
	}
}

func TestJWKSRejectsMalformedStoredKey(t *testing.T) {
	priv := newRSA(t)
	k := testKey(t, priv, &priv.PublicKey, true)
	k.KID = "someone-else"
	if rec := serveJWKS(t, staticKeys{k}, http.MethodGet, nil); rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
