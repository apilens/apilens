package passkey

import (
	"context"
	"errors"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/apilens/apilens/internal/platform/config"
)

func TestNewRelyingParty(t *testing.T) {
	rp, err := NewRelyingParty(config.WebAuthnConfig{
		RPID: "example.com", RPName: "APILens",
		Origins: []string{"https://app.example.com", "https://example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	c := rp.Config
	if c.RPID != "example.com" || c.RPDisplayName != "APILens" || len(c.RPOrigins) != 2 {
		t.Errorf("config = %+v", c)
	}
	if c.AuthenticatorSelection.ResidentKey != protocol.ResidentKeyRequirementPreferred ||
		c.AuthenticatorSelection.UserVerification != protocol.VerificationPreferred {
		t.Errorf("authenticator selection = %+v", c.AuthenticatorSelection)
	}
}

func TestNewRelyingPartyRejects(t *testing.T) {
	for name, cfg := range map[string]config.WebAuthnConfig{
		"no name":          {RPID: "example.com", Origins: []string{"https://example.com"}},
		"no origins":       {RPID: "example.com", RPName: "APILens"},
		"foreign origin":   {RPID: "example.com", RPName: "APILens", Origins: []string{"https://example.org"}},
		"public suffix":    {RPID: "co.uk", RPName: "APILens", Origins: []string{"https://app.co.uk"}},
		"rp id with port":  {RPID: "example.com:443", RPName: "APILens", Origins: []string{"https://example.com"}},
		"rp id is a URL":   {RPID: "https://example.com", RPName: "APILens", Origins: []string{"https://example.com"}},
		"rp id is too low": {RPID: "app.example.com", RPName: "APILens", Origins: []string{"https://example.com"}},
	} {
		if _, err := NewRelyingParty(cfg); err == nil {
			t.Errorf("%s: NewRelyingParty(%+v) succeeded", name, cfg)
		}
	}
}

func TestChallengeStoreUnavailable(t *testing.T) {
	s := NewValkeyChallengeStore(nil)
	ctx := context.Background()
	if _, err := s.Put(ctx, CeremonyLogin, webauthn.SessionData{Challenge: "c"}); !errors.Is(err, ErrChallengeStoreUnavailable) {
		t.Errorf("put: err = %v", err)
	}
	if _, err := s.Take(ctx, CeremonyLogin, "id"); !errors.Is(err, ErrChallengeStoreUnavailable) {
		t.Errorf("take: err = %v", err)
	}
}

func TestChallengeIDsAreRandom(t *testing.T) {
	a, b := newChallengeID(), newChallengeID()
	if a == b || len(a) != 43 {
		t.Fatalf("ids %q, %q: want distinct 43-char base64url", a, b)
	}
}
