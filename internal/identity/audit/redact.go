package audit

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Redacted replaces the value of a secret field in recorded changes.
const Redacted = "[redacted]"

// ErrSecret is returned by Record for changes that carry a secret: a value
// under a secret field name (see Redact) or a string that is API key material.
var ErrSecret = errors.New("changes hold a secret")

// secretFields are field names whose values are secrets, compared
// case-insensitively. Names ending in a secretSuffixes entry are secret too.
var secretFields = []string{
	"secret", "password", "passphrase", "token", "code", "otp", "key", "hash",
	"raw_key", "api_key", "key_hash", "private_key", "client_secret", "client_secret_enc",
	"totp_secret", "recovery_code", "recovery_codes",
}

var secretSuffixes = []string{"_secret", "_secret_enc", "_token", "_password", "_hash", "_private_key"}

// keyMaterialPrefixes are the prefixes of raw API keys (apikeys.Prefix and
// apikeys.LegacyPrefix); a string this long with one of them is a key, not
// the short display prefix.
var keyMaterialPrefixes = []string{"apl_live_", "apilens_"}

const minKeyMaterialLen = 40

// IsSecretField reports whether a changes field named name holds a secret.
func IsSecretField(name string) bool {
	n := strings.ToLower(name)
	if slices.Contains(secretFields, n) {
		return true
	}
	for _, s := range secretSuffixes {
		if strings.HasSuffix(n, s) {
			return true
		}
	}
	return false
}

func isKeyMaterial(s string) bool {
	if len(s) < minKeyMaterialLen {
		return false
	}
	for _, p := range keyMaterialPrefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// Redact returns a copy of m, for Changes, in which the value of every
// secret field (at any depth) that is set is replaced by Redacted, so the
// change records that a secret changed without recording it.
func Redact(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		if IsSecretField(k) && v != nil {
			out[k] = Redacted
			continue
		}
		out[k] = redactValue(v)
	}
	return out
}

func redactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return Redact(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = redactValue(e)
		}
		return out
	default:
		return v
	}
}

// checkNoSecrets returns ErrSecret when the encoded changes hold a secret
// field with a value other than null or Redacted, or API key material.
func checkNoSecrets(encoded []byte) error {
	d := json.NewDecoder(bytes.NewReader(encoded))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return walkSecrets("", v)
}

func walkSecrets(path string, v any) error {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			p := path + "." + k
			if IsSecretField(k) && e != nil && e != Redacted {
				return fmt.Errorf("%w: %s", ErrSecret, strings.TrimPrefix(p, "."))
			}
			if err := walkSecrets(p, e); err != nil {
				return err
			}
		}
	case []any:
		for i, e := range t {
			if err := walkSecrets(fmt.Sprintf("%s[%d]", path, i), e); err != nil {
				return err
			}
		}
	case string:
		if isKeyMaterial(t) {
			return fmt.Errorf("%w: key material at %s", ErrSecret, strings.TrimPrefix(path, "."))
		}
	}
	return nil
}
