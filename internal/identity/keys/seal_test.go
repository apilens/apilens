package keys

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"testing"
)

func testKEK(t *testing.T) []byte {
	t.Helper()
	kek := make([]byte, KEKSize)
	if _, err := rand.Read(kek); err != nil {
		t.Fatal(err)
	}
	return kek
}

func TestSealerRejectsWrongKEKSize(t *testing.T) {
	for _, n := range []int{0, 16, 31, 33, 64} {
		if _, err := NewSealer(make([]byte, n)); err == nil {
			t.Errorf("NewSealer(%d bytes) should fail", n)
		}
	}
}

func TestSealRoundTripsAndHidesPlaintext(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSealer(testKEK(t))
	if err != nil {
		t.Fatal(err)
	}
	ad := additionalData("kid-1")

	sealed, err := s.Seal(plaintext, ad)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(sealed, plaintext) {
		t.Fatal("ciphertext equals plaintext")
	}
	if bytes.Contains(sealed, plaintext[len(plaintext)-64:]) {
		t.Fatal("ciphertext contains plaintext bytes")
	}
	if want := 1 + 12 + len(plaintext) + 16; len(sealed) != want {
		t.Errorf("sealed length = %d, want %d (version+nonce+ciphertext+tag)", len(sealed), want)
	}

	got, err := s.Open(sealed, ad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatal("round trip changed the plaintext")
	}

	again, err := s.Seal(plaintext, ad)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(again, sealed) {
		t.Error("sealing twice must use a fresh nonce")
	}
}

func TestOpenFailsClosed(t *testing.T) {
	s, err := NewSealer(testKEK(t))
	if err != nil {
		t.Fatal(err)
	}
	other, err := NewSealer(testKEK(t))
	if err != nil {
		t.Fatal(err)
	}
	ad := additionalData("kid-1")
	sealed, err := s.Seal([]byte("secret key material"), ad)
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 1
	badVersion := bytes.Clone(sealed)
	badVersion[0] = 0

	cases := map[string]func() ([]byte, error){
		"wrong KEK":            func() ([]byte, error) { return other.Open(sealed, ad) },
		"moved to another kid": func() ([]byte, error) { return s.Open(sealed, additionalData("kid-2")) },
		"tampered":             func() ([]byte, error) { return s.Open(tampered, ad) },
		"unknown version":      func() ([]byte, error) { return s.Open(badVersion, ad) },
		"truncated":            func() ([]byte, error) { return s.Open(sealed[:10], ad) },
		"empty":                func() ([]byte, error) { return s.Open(nil, ad) },
	}
	for name, open := range cases {
		got, err := open()
		if !errors.Is(err, ErrDecrypt) || got != nil {
			t.Errorf("%s: got (%q, %v), want ErrDecrypt", name, got, err)
		}
	}
}
