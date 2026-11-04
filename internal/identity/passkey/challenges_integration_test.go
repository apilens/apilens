//go:build integration

package passkey

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/testutil"
)

func TestValkeyChallengeStoreRoundTrip(t *testing.T) {
	ctx := context.Background()
	client, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	store := NewValkeyChallengeStore(client)

	// A real registration SessionData, as BeginRegistration produces it.
	rp, err := NewRelyingParty(config.WebAuthnConfig{
		RPID: "localhost", RPName: "APILens", Origins: []string{"http://localhost:3000"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, sd, err := rp.BeginRegistration(testUser{})
	if err != nil {
		t.Fatal(err)
	}

	id, err := store.Put(ctx, CeremonyRegistration, *sd)
	if err != nil {
		t.Fatal(err)
	}
	ttl, err := client.Do(ctx, client.B().Ttl().Key(challengeKeyPrefix+id).Build()).AsInt64()
	if err != nil || ttl <= 0 || ttl > int64(ChallengeTTL/time.Second) {
		t.Fatalf("challenge ttl = %d (%v), want 1..%d s", ttl, err, int64(ChallengeTTL/time.Second))
	}

	// The wrong ceremony does not see it, but the attempt still burns it: a
	// challenge is presented once.
	if _, err := store.Take(ctx, CeremonyLogin, id); !errors.Is(err, ErrChallengeNotFound) {
		t.Fatalf("take as login: err = %v, want ErrChallengeNotFound", err)
	}
	if _, err := store.Take(ctx, CeremonyRegistration, id); !errors.Is(err, ErrChallengeNotFound) {
		t.Fatalf("take after wrong ceremony: err = %v, want ErrChallengeNotFound", err)
	}

	id, err = store.Put(ctx, CeremonyRegistration, *sd)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Take(ctx, CeremonyRegistration, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Challenge != sd.Challenge || got.RelyingPartyID != "localhost" ||
		!slices.Equal(got.UserID, sd.UserID) || !got.Expires.Equal(sd.Expires) ||
		got.UserVerification != protocol.VerificationPreferred || len(got.CredParams) != len(sd.CredParams) {
		t.Fatalf("round trip:\n got  %+v\n want %+v", got, *sd)
	}
	if _, err := store.Take(ctx, CeremonyRegistration, id); !errors.Is(err, ErrChallengeNotFound) {
		t.Fatalf("second take: err = %v, want ErrChallengeNotFound", err)
	}
	if _, err := store.Take(ctx, CeremonyLogin, "missing"); !errors.Is(err, ErrChallengeNotFound) {
		t.Fatalf("missing: err = %v, want ErrChallengeNotFound", err)
	}
}

type testUser struct{}

func (testUser) WebAuthnID() []byte                         { return []byte("user-1") }
func (testUser) WebAuthnName() string                       { return "ada@example.com" }
func (testUser) WebAuthnDisplayName() string                { return "Ada" }
func (testUser) WebAuthnCredentials() []webauthn.Credential { return nil }
