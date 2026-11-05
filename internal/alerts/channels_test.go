package alerts

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	idkeys "github.com/apilens/apilens/internal/identity/keys"
)

func testSealer(t *testing.T) *idkeys.Sealer {
	t.Helper()
	kek := make([]byte, idkeys.KEKSize)
	if _, err := rand.Read(kek); err != nil {
		t.Fatal(err)
	}
	s, err := idkeys.NewSealer(kek)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestChannelTypeValid(t *testing.T) {
	for _, ct := range []ChannelType{ChannelEmail, ChannelSlack, ChannelTeams, ChannelWebhook} {
		if !ct.Valid() {
			t.Errorf("%q should be valid", ct)
		}
	}
	for _, ct := range []ChannelType{"", "sms", "Slack"} {
		if ct.Valid() {
			t.Errorf("%q should be invalid", ct)
		}
	}
}

func TestChannelConfigSealRoundTripsAndHidesSecrets(t *testing.T) {
	s := testSealer(t)
	channel := uuid.New()
	const hook = "https://hooks.slack.com/services/T000/B000/secret-token"
	config := json.RawMessage(`{"url":"` + hook + `"}`)

	sealed, err := SealChannelConfig(s, channel, config)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("secret-token")) || bytes.Contains(sealed, []byte("hooks.slack.com")) {
		t.Fatal("sealed config contains plaintext")
	}
	got, err := OpenChannelConfig(s, channel, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, config) {
		t.Fatalf("opened = %s, want %s", got, config)
	}

	again, err := SealChannelConfig(s, channel, config)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(again, sealed) {
		t.Fatal("two seals of one config must differ (fresh nonce)")
	}
}

func TestChannelConfigBoundToChannelAndKEK(t *testing.T) {
	s := testSealer(t)
	channel := uuid.New()
	sealed, err := SealChannelConfig(s, channel, json.RawMessage(`{"to":["ops@example.com"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenChannelConfig(s, uuid.New(), sealed); !errors.Is(err, idkeys.ErrDecrypt) {
		t.Errorf("open as another channel = %v, want ErrDecrypt", err)
	}
	if _, err := OpenChannelConfig(testSealer(t), channel, sealed); !errors.Is(err, idkeys.ErrDecrypt) {
		t.Errorf("open with another KEK = %v, want ErrDecrypt", err)
	}
	tampered := bytes.Clone(sealed)
	tampered[len(tampered)-1] ^= 1
	if _, err := OpenChannelConfig(s, channel, tampered); !errors.Is(err, idkeys.ErrDecrypt) {
		t.Errorf("open tampered = %v, want ErrDecrypt", err)
	}
}

func TestSealChannelConfigRejectsNonObjects(t *testing.T) {
	s := testSealer(t)
	for _, c := range []string{``, `null`, `[]`, `"https://example.com"`, `42`, `{"url":`} {
		if _, err := SealChannelConfig(s, uuid.New(), json.RawMessage(c)); !errors.Is(err, ErrConfigNotObject) {
			t.Errorf("seal %q = %v, want ErrConfigNotObject", c, err)
		}
	}
}
