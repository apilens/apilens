package passkey

import (
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/session"
)

// MaxNameLen bounds a passkey's name, in characters (the
// passkey_credentials.name check).
const MaxNameLen = 64

// FallbackName names a passkey whose authenticator and user agent are both
// unknown.
const FallbackName = "Passkey"

// authenticators maps well-known AAGUIDs to the authenticator's product
// name, for a passkey's default name. It is a small embedded table of the
// common passkey providers and security keys, not the FIDO metadata service;
// an unknown AAGUID falls back to the user agent.
//
// Sources: the community passkey-authenticator-aaguids list and Yubico's
// published AAGUIDs.
var authenticators = map[uuid.UUID]string{
	// Platform and password-manager passkeys.
	uuid.MustParse("fbfc3007-154e-4ecc-8c0b-6e020557d7bd"): "iCloud Keychain",
	uuid.MustParse("dd4ec289-e01d-41c9-bb89-70fa845d4bf2"): "iCloud Keychain",
	uuid.MustParse("ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4"): "Google Password Manager",
	uuid.MustParse("adce0002-35bc-c60a-648b-0b25f1f05503"): "Chrome on Mac",
	uuid.MustParse("08987058-cadc-4b81-b6e1-30de50dcbe96"): "Windows Hello",
	uuid.MustParse("9ddd1817-af5a-4672-a2b9-3e3dd95000a9"): "Windows Hello",
	uuid.MustParse("6028b017-b1d4-4c02-b4b3-afcdafc96bb2"): "Windows Hello",
	uuid.MustParse("bada5566-a7aa-401f-bd96-45619a55120d"): "1Password",
	uuid.MustParse("d548826e-79b4-db40-a3d8-11116f7e8349"): "Bitwarden",
	uuid.MustParse("531126d6-e717-415c-9320-3d9aa6981239"): "Dashlane",
	uuid.MustParse("0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6"): "Keeper",
	uuid.MustParse("b84e4048-15dc-4dd0-8640-f4f60813c8af"): "NordPass",
	uuid.MustParse("53414d53-554e-4700-0000-000000000000"): "Samsung Pass",
	// Security keys.
	uuid.MustParse("cb69481e-8ff7-4039-93ec-0a2729a154a8"): "YubiKey 5",
	uuid.MustParse("ee882879-721c-4913-9775-3dfcce97072a"): "YubiKey 5",
	uuid.MustParse("fa2b99dc-9e39-4257-8f92-4a30d23c4118"): "YubiKey 5",
	uuid.MustParse("2fc0579f-8113-47ea-b116-bb5a8db9202a"): "YubiKey 5",
	uuid.MustParse("c5ef55ff-ad9a-4b9f-b580-adebafe026d0"): "YubiKey 5",
	uuid.MustParse("73bb0cd4-e502-49b8-9c6f-b59445bf720b"): "YubiKey 5",
	uuid.MustParse("f8a011f3-8c0a-4d15-8006-17111f9edc7d"): "Security Key by Yubico",
	uuid.MustParse("b92c3f9a-c014-4056-887f-140a2501163b"): "Security Key by Yubico",
}

// AuthenticatorName returns the product name of the authenticator model
// aaguid, or "" when it is not in the table (including the all-zero AAGUID
// of an authenticator that did not say).
func AuthenticatorName(aaguid uuid.UUID) string {
	return authenticators[aaguid]
}

// DefaultName names a new passkey the user did not name: the authenticator's
// product name when its AAGUID is known, else the device label of the user
// agent that registered it ("Chrome on macOS"), else FallbackName.
func DefaultName(aaguid uuid.UUID, userAgent string) string {
	if n := AuthenticatorName(aaguid); n != "" {
		return n
	}
	if l := session.DeviceLabel(userAgent); l != session.UnknownDevice {
		return ClampName(l)
	}
	return FallbackName
}

// ClampName trims s and cuts it to at most MaxNameLen characters.
func ClampName(s string) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= MaxNameLen {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:MaxNameLen]))
}
