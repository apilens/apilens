// Package apps owns the apps of a project: the services of the product the
// project describes. Apps come from the SDK: the app name an SDK sends
// decides the app, and ingest creates an app it has not seen yet through
// Insert, the same code path the control plane uses for the default app of a
// new project. The dashboard archives, restores, renames, merges and deletes
// them (Service).
package apps

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxSlugLen bounds an app slug (apps.slug CHECK: 1..63 characters).
const MaxSlugLen = 63

// MaxNameLen bounds an app's display name in runes.
const MaxNameLen = 100

// DefaultSlug names the app created for records that name no app when a
// project has no default app yet.
const DefaultSlug = "default"

var slugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ValidSlug reports whether s satisfies the apps.slug CHECK.
func ValidSlug(s string) bool { return slugRE.MatchString(s) }

// Normalize maps what an SDK sends as its app name to the app slug: lower
// case, surrounding space trimmed, spaces and underscores become '-', other
// characters outside [a-z0-9-] are dropped, runs of '-' collapse and leading
// or trailing '-' go, and the result is cut to MaxSlugLen. "Orders API",
// "orders_api" and "orders-api" are the same app. ok is false when nothing
// usable is left.
func Normalize(name string) (slug string, ok bool) {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case r == '-' || r == '_' || unicode.IsSpace(r):
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > MaxSlugLen {
		s = strings.TrimRight(s[:MaxSlugLen], "-")
	}
	if !ValidSlug(s) {
		return "", false
	}
	return s, true
}

// DisplayName is the name an app gets from the text an SDK sent: trimmed,
// inner whitespace collapsed, at most MaxNameLen runes.
func DisplayName(name string) string {
	s := strings.Join(strings.Fields(name), " ")
	if utf8.RuneCountInString(s) > MaxNameLen {
		s = string([]rune(s)[:MaxNameLen])
	}
	return s
}
