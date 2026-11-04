package keys

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestKeyNeverFormatsPrivateMaterial(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	kid := Thumbprint(&priv.PublicKey)
	jwk, err := publicJWK(kid, &priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k := Key{KID: kid, Alg: AlgRS256, PublicJWK: jwk, CreatedAt: now, ActivatedAt: &now, private: priv}

	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	secrets := []string{
		priv.D.String(), // decimal, as %v of a big.Int prints it
		priv.D.Text(16), // hex
		priv.Primes[0].String(),
		base64.StdEncoding.EncodeToString(der)[:64],
		base64.RawURLEncoding.EncodeToString(priv.D.Bytes())[:32],
	}

	var buf bytes.Buffer
	for _, verb := range []string{"%v", "%+v", "%#v", "%s"} {
		fmt.Fprintf(&buf, verb+"\n", k)
		fmt.Fprintf(&buf, verb+"\n", &k)
		fmt.Fprintf(&buf, verb+"\n", []Key{k})
	}
	for _, h := range []slog.Handler{slog.NewTextHandler(&buf, nil), slog.NewJSONHandler(&buf, nil)} {
		l := slog.New(h)
		l.Info("loaded", "key", k)
		l.Info("loaded", "keys", []Key{k})
		l.Info("loaded", slog.Any("key", &k))
	}
	if b, err := json.Marshal(k); err == nil {
		buf.Write(b)
	}
	out := buf.String()
	if !strings.Contains(out, kid) {
		t.Fatalf("output should still name the kid:\n%s", out)
	}
	for _, s := range secrets {
		if strings.Contains(out, s) {
			t.Fatalf("private key material leaked into formatted output:\n%s", out)
		}
	}
}

func TestThumbprintMatchesRFC7638Example(t *testing.T) {
	// RFC 7638 §3.1.
	n, _ := base64.RawURLEncoding.DecodeString("0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw")
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: 65537}
	if got, want := Thumbprint(pub), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"; got != want {
		t.Fatalf("Thumbprint = %s, want %s", got, want)
	}
}

func TestPublicJWKHasNoPrivateMembers(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	jwk, err := publicJWK("kid-1", &priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]string
	if err := json.Unmarshal(jwk, &m); err != nil {
		t.Fatal(err)
	}
	for _, member := range []string{"d", "p", "q", "dp", "dq", "qi"} {
		if _, ok := m[member]; ok {
			t.Errorf("public JWK has private member %q", member)
		}
	}
	if m["kty"] != "RSA" || m["alg"] != AlgRS256 || m["use"] != "sig" || m["kid"] != "kid-1" || m["e"] != "AQAB" {
		t.Errorf("unexpected JWK %s", jwk)
	}
}

func TestRSAKeyRejectsWeakKeys(t *testing.T) {
	weak, err := rsa.GenerateKey(rand.Reader, 1024) //nolint:gosec // deliberately weak for the test
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rsaKey(weak); err == nil {
		t.Fatal("1024-bit key should be rejected")
	}
}

func TestActive(t *testing.T) {
	now := time.Now()
	keys := []Key{
		{KID: "pending"},
		{KID: "retired", ActivatedAt: &now, RetiredAt: &now},
		{KID: "active", ActivatedAt: &now},
	}
	if k, ok := Active(keys); !ok || k.KID != "active" {
		t.Fatalf("Active = %v, %t", k, ok)
	}
	if _, ok := Active(keys[:2]); ok {
		t.Fatal("no active key expected")
	}
}
