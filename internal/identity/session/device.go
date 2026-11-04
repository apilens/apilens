package session

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxUserAgentLen bounds the user agent stored with a session, in bytes.
// Longer values are truncated (on a UTF-8 boundary) before they are stored
// or parsed.
const MaxUserAgentLen = 512

// maxClientNameLen bounds the product name taken from a non-browser user
// agent ("curl", "PostmanRuntime") for its device label.
const maxClientNameLen = 32

// UnknownDevice is the device label of a session whose user agent names
// neither a known browser nor an operating system.
const UnknownDevice = "Unknown device"

// TruncateUserAgent returns ua cut to at most MaxUserAgentLen bytes without
// splitting a UTF-8 sequence.
func TruncateUserAgent(ua string) string {
	if len(ua) <= MaxUserAgentLen {
		return ua
	}
	cut := MaxUserAgentLen
	for cut > 0 && !utf8.RuneStart(ua[cut]) {
		cut--
	}
	return ua[:cut]
}

// browsers are matched in order: many user agents name several products
// (Edge and Opera also say "Chrome", Chrome also says "Safari"), so the most
// specific comes first.
var browsers = []struct{ token, name string }{
	{"EdgiOS/", "Edge"},
	{"EdgA/", "Edge"},
	{"Edg/", "Edge"},
	{"Edge/", "Edge"},
	{"OPR/", "Opera"},
	{"OPiOS/", "Opera"},
	{"Opera", "Opera"},
	{"SamsungBrowser/", "Samsung Internet"},
	{"Vivaldi/", "Vivaldi"},
	{"YaBrowser/", "Yandex Browser"},
	{"FxiOS/", "Firefox"},
	{"Firefox/", "Firefox"},
	{"CriOS/", "Chrome"},
	{"Chromium/", "Chromium"},
	{"Chrome/", "Chrome"},
	{"MSIE ", "Internet Explorer"},
	{"Trident/", "Internet Explorer"},
}

// systems are matched in order: iOS user agents say "like Mac OS X" and
// Android ones say "Linux".
var systems = []struct{ token, name string }{
	{"iPhone", "iOS"},
	{"iPad", "iPadOS"},
	{"iPod", "iOS"},
	{"Android", "Android"},
	{"CrOS", "ChromeOS"},
	{"Windows Phone", "Windows Phone"},
	{"Windows", "Windows"},
	{"Macintosh", "macOS"},
	{"Mac OS X", "macOS"},
	{"Ubuntu", "Ubuntu"},
	{"Fedora", "Fedora"},
	{"FreeBSD", "FreeBSD"},
	{"Linux", "Linux"},
}

// DeviceLabel derives a human-readable device name for the sessions list
// from a user agent: "<browser> on <OS>" ("Chrome on macOS"), the browser or
// OS alone when only one is known, the product name of a non-browser client
// ("curl"), or UnknownDevice. It is a small local parser, not a full user
// agent database; a wrong guess only affects a label.
func DeviceLabel(ua string) string {
	ua = strings.TrimSpace(TruncateUserAgent(ua))
	if ua == "" {
		return UnknownDevice
	}
	browser := browserOf(ua)
	system := match(ua, systems)
	switch {
	case browser != "" && system != "":
		return browser + " on " + system
	case browser != "":
		return browser
	case system != "":
		return system
	}
	if name := clientName(ua); name != "" {
		return name
	}
	return UnknownDevice
}

func browserOf(ua string) string {
	if b := match(ua, browsers); b != "" {
		return b
	}
	// Safari names no product of its own beyond "Safari/" and "Version/",
	// which in-app browsers and other WebKit shells lack.
	if strings.Contains(ua, "Safari/") && strings.Contains(ua, "Version/") {
		return "Safari"
	}
	return ""
}

func match(ua string, table []struct{ token, name string }) string {
	for _, e := range table {
		if strings.Contains(ua, e.token) {
			return e.name
		}
	}
	return ""
}

// clientName returns the product of a non-browser user agent ("curl/8.4.0"
// gives "curl"), or "" for a Mozilla-style one or an unprintable name.
func clientName(ua string) string {
	name, _, _ := strings.Cut(ua, "/")
	name, _, _ = strings.Cut(name, " ")
	if name == "" || name == "Mozilla" || len(name) > maxClientNameLen {
		return ""
	}
	for _, r := range name {
		allowed := unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune("-_.+", r)
		if r > unicode.MaxASCII || !allowed {
			return ""
		}
	}
	return name
}
