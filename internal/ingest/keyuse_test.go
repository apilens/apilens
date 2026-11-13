package ingest

import (
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/apilens/apilens/internal/platform/config"
)

func TestKeyUse(t *testing.T) {
	for _, tc := range []struct {
		name     string
		ua, peer string
		recordIP bool
		sdk      string
		ip       netip.Addr
	}{
		{"sdk and ipv4", "apilenss/0.5.0 (python 3.13)", "203.0.113.7:51234", true, "apilenss/0.5.0", netip.MustParseAddr("203.0.113.7")},
		{"ipv6 peer", "OTel-OTLP-Exporter-Go/1.38.0", "[2001:db8::1]:443", true, "OTel-OTLP-Exporter-Go/1.38.0", netip.MustParseAddr("2001:db8::1")},
		{"ipv4-mapped", "x/1", "[::ffff:198.51.100.2]:1", true, "x/1", netip.MustParseAddr("198.51.100.2")},
		{"ip not recorded", "apilenss/0.5.0", "203.0.113.7:51234", false, "apilenss/0.5.0", netip.Addr{}},
		{"no user agent", "", "garbage", true, "", netip.Addr{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := &Edge{cfg: config.IngestConfig{RecordKeyIP: tc.recordIP}}
			r := httptest.NewRequest("POST", "/v1/requests", nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("User-Agent", tc.ua)
			if tc.ua == "" {
				r.Header.Del("User-Agent")
			}
			u := e.keyUse(r)
			if u.SDK != tc.sdk || u.IP != tc.ip {
				t.Fatalf("keyUse = %+v, want sdk %q ip %v", u, tc.sdk, tc.ip)
			}
		})
	}
}
