package session

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDeviceLabel(t *testing.T) {
	for ua, want := range map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36":                          "Chrome on macOS",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0":                  "Edge on Windows",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0":                                                               "Firefox on Windows",
		"Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0":                                                                         "Firefox on Linux",
		"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0":                                                                 "Firefox on Ubuntu",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15":                          "Safari on macOS",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1":        "Safari on iOS",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1": "Chrome on iOS",
		"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15":               "Firefox on iPadOS",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36":                          "Chrome on Android",
		"Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36":     "Samsung Internet on Android",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0":                  "Opera on Windows",
		"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36":                                 "Chrome on ChromeOS",
		"Mozilla/5.0 (Windows NT 10.0; Trident/7.0; rv:11.0) like Gecko":                                                                                 "Internet Explorer on Windows",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)":                                                                                                "macOS",
		"curl/8.4.0":                     "curl",
		"PostmanRuntime/7.42.0":          "PostmanRuntime",
		"Go-http-client/1.1":             "Go-http-client",
		"python-requests/2.32":           "python-requests",
		"":                               UnknownDevice,
		"   ":                            UnknownDevice,
		"Mozilla/5.0":                    UnknownDevice,
		"<script>/1":                     UnknownDevice,
		strings.Repeat("x", 40) + "/1.0": UnknownDevice,
	} {
		if got := DeviceLabel(ua); got != want {
			t.Errorf("DeviceLabel(%.60q) = %q, want %q", ua, got, want)
		}
	}
}

func TestTruncateUserAgent(t *testing.T) {
	short := "curl/8.4.0"
	if got := TruncateUserAgent(short); got != short {
		t.Errorf("short ua changed: %q", got)
	}
	long := strings.Repeat("a", 2000)
	if got := TruncateUserAgent(long); len(got) != MaxUserAgentLen {
		t.Errorf("len = %d, want %d", len(got), MaxUserAgentLen)
	}
	// A multi-byte rune straddling the limit is dropped whole.
	multi := strings.Repeat("a", MaxUserAgentLen-1) + "é" + "tail"
	got := TruncateUserAgent(multi)
	if len(got) != MaxUserAgentLen-1 || !utf8.ValidString(got) {
		t.Errorf("len = %d valid = %v", len(got), utf8.ValidString(got))
	}
}
