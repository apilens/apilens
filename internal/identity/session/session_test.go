package session

import (
	"bytes"
	"encoding/base64"
	"log/slog"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
)

func TestNewToken(t *testing.T) {
	raw, hash, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(b) != tokenBytes {
		t.Fatalf("raw %q decodes to %d bytes (%v), want %d", raw, len(b), err, tokenBytes)
	}
	if hash != Hash(raw) || hash == raw || !wellFormed(raw) {
		t.Fatalf("hash %q of %q", hash, raw)
	}
	if other, _, _ := newToken(); other == raw {
		t.Fatal("two tokens are equal")
	}
}

func TestWellFormed(t *testing.T) {
	for raw, want := range map[string]bool{
		"":                        false,
		"has space":               false,
		"padded==":                false,
		strings.Repeat("A", 513):  false,
		"AAAAAAAAAAAAAAAAAAAAAAA": true,
	} {
		if got := wellFormed(raw); got != want {
			t.Errorf("wellFormed(%.20q) = %v, want %v", raw, got, want)
		}
	}
}

func TestTokensLogValueRedacts(t *testing.T) {
	tok := Tokens{
		AccessToken:  "secret-access",
		RefreshToken: "secret-refresh",
		Session:      db.Session{ID: uuid.New(), FamilyID: uuid.New()},
		User:         db.User{ID: uuid.New()},
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("signed in", "tokens", tok)
	out := buf.String()
	if strings.Contains(out, "secret") || !strings.Contains(out, tok.Session.ID.String()) {
		t.Fatalf("log = %s", out)
	}
}
