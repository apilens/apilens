package twofactor

import (
	"bytes"
	"errors"
	"regexp"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/keys"
)

var testKEK = bytes.Repeat([]byte{7}, keys.KEKSize)

func TestNewBackupCodes(t *testing.T) {
	codes, err := NewBackupCodes()
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != BackupCodeCount {
		t.Fatalf("got %d codes, want %d", len(codes), BackupCodeCount)
	}
	format := regexp.MustCompile(`^[a-z2-7]{4}-[a-z2-7]{4}$`)
	seen := map[string]bool{}
	for _, c := range codes {
		if !format.MatchString(c) {
			t.Errorf("code %q is not xxxx-xxxx", c)
		}
		if seen[c] {
			t.Errorf("duplicate code %q", c)
		}
		seen[c] = true
	}
}

func TestHashBackupCode(t *testing.T) {
	ada, bob := uuid.New(), uuid.New()
	h := HashBackupCode(ada, "abcd-efgh")
	for _, same := range []string{"ABCD-EFGH", "abcdefgh", " abcd efgh\n"} {
		if got := HashBackupCode(ada, same); got != h {
			t.Errorf("%q hashes differently from abcd-efgh", same)
		}
	}
	if HashBackupCode(bob, "abcd-efgh") == h {
		t.Error("the hash must be salted with the user id")
	}
	if HashBackupCode(ada, "abcd-efgx") == h {
		t.Error("different codes must hash differently")
	}
	if bytes.Contains([]byte(h), []byte("abcd")) {
		t.Error("the hash must not contain the code")
	}
}

func TestSecretSealing(t *testing.T) {
	svc, err := New(nil, testKEK, nil)
	if err != nil {
		t.Fatal(err)
	}
	ada, bob := uuid.New(), uuid.New()
	const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
	sealed, err := svc.SealSecret(ada, secret)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte(secret)) {
		t.Fatal("ciphertext contains the secret")
	}
	again, err := svc.SealSecret(ada, secret)
	if err != nil || bytes.Equal(sealed, again) {
		t.Fatalf("sealing twice must use fresh nonces (err %v)", err)
	}
	got, err := svc.OpenSecret(ada, sealed)
	if err != nil || got != secret {
		t.Fatalf("open = %q, %v", got, err)
	}
	if _, err := svc.OpenSecret(bob, sealed); !errors.Is(err, keys.ErrDecrypt) {
		t.Fatalf("another user's ciphertext: want ErrDecrypt, got %v", err)
	}
	other, err := New(nil, bytes.Repeat([]byte{8}, keys.KEKSize), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.OpenSecret(ada, sealed); !errors.Is(err, keys.ErrDecrypt) {
		t.Fatalf("wrong KEK: want ErrDecrypt, got %v", err)
	}
}

func TestNewRejectsBadKEK(t *testing.T) {
	if _, err := New(nil, []byte("short"), nil); err == nil {
		t.Fatal("want an error for a short KEK")
	}
}
