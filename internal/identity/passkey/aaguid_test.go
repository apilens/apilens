package passkey

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/google/uuid"
)

func TestAuthenticatorTable(t *testing.T) {
	for id, name := range authenticators {
		if id == uuid.Nil || name == "" || utf8.RuneCountInString(name) > MaxNameLen {
			t.Errorf("entry %s = %q", id, name)
		}
	}
	if got := AuthenticatorName(uuid.Nil); got != "" {
		t.Errorf("AuthenticatorName(nil) = %q, want empty", got)
	}
}

func TestDefaultName(t *testing.T) {
	const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	onePassword := uuid.MustParse("bada5566-a7aa-401f-bd96-45619a55120d")
	for _, tc := range []struct {
		name   string
		aaguid uuid.UUID
		ua     string
		want   string
	}{
		{"known aaguid wins", onePassword, chromeMac, "1Password"},
		{"security key", uuid.MustParse("cb69481e-8ff7-4039-93ec-0a2729a154a8"), "", "YubiKey 5"},
		{"unknown aaguid uses the user agent", uuid.New(), chromeMac, "Chrome on macOS"},
		{"zero aaguid uses the user agent", uuid.Nil, chromeMac, "Chrome on macOS"},
		{"nothing known", uuid.Nil, "", FallbackName},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := DefaultName(tc.aaguid, tc.ua); got != tc.want {
				t.Errorf("DefaultName = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClampName(t *testing.T) {
	if got := ClampName("  Work laptop  "); got != "Work laptop" {
		t.Errorf("trim: %q", got)
	}
	long := strings.Repeat("é", MaxNameLen+10)
	if got := ClampName(long); utf8.RuneCountInString(got) != MaxNameLen {
		t.Errorf("clamp: %d runes", utf8.RuneCountInString(got))
	}
	if got := ClampName("   "); got != "" {
		t.Errorf("blank: %q", got)
	}
}
