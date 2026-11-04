package ratelimit

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/apilens/apilens/internal/platform/config"
)

// newTestAPI mounts GET /limited behind l.Limit. The test client's peer
// address is whatever remote sets via the request.
func newTestAPI(t *testing.T, l *Limiter, perIP Rate, perKey Key) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	huma.Register(api, huma.Operation{
		OperationID: "limited", Method: http.MethodGet, Path: "/limited",
		Middlewares: huma.Middlewares{l.Limit(api, "test", perIP, perKey)},
	}, func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })
	return api
}

func TestFailsClosedWithoutValkey(t *testing.T) {
	var logs bytes.Buffer
	l, err := New(nil, slog.New(slog.NewTextHandler(&logs, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1_000, 0)
	l.now = func() time.Time { return clock }
	api := newTestAPI(t, l, Rate{Limit: 5, Window: time.Minute}, Key{})

	for range 3 {
		if resp := api.Get("/limited"); resp.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503 (fail closed)", resp.Code)
		}
	}
	if n := strings.Count(logs.String(), "rate limiter unavailable"); n != 1 {
		t.Fatalf("logged %d times within a minute, want 1:\n%s", n, logs.String())
	}
	clock = clock.Add(logEvery)
	api.Get("/limited")
	if n := strings.Count(logs.String(), "rate limiter unavailable"); n != 2 {
		t.Fatalf("logged %d times after a minute, want 2", n)
	}

	err = l.Check(context.Background(), "test", "a@example.com", Rate{Limit: 1, Window: time.Minute})
	var se huma.StatusError
	if !errors.As(err, &se) || se.GetStatus() != http.StatusServiceUnavailable {
		t.Fatalf("Check err = %v, want 503", err)
	}
}

func TestDisabledRatesPassThrough(t *testing.T) {
	l, err := New(nil, slog.New(slog.DiscardHandler), nil)
	if err != nil {
		t.Fatal(err)
	}
	api := newTestAPI(t, l, Rate{}, Key{Rate: Rate{}, From: func(huma.Context) string { return "x" }})
	if resp := api.Get("/limited"); resp.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.Code)
	}
	// An empty subject skips the per-key limit too.
	api = newTestAPI(t, l, Rate{}, Key{Rate: Rate{Limit: 1, Window: time.Minute}, From: func(huma.Context) string { return "" }})
	if resp := api.Get("/limited"); resp.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.Code)
	}
}

func TestRateConvertsFromConfig(t *testing.T) {
	r := Rate(config.RateLimit{Limit: 5, Window: 15 * time.Minute})
	if r != (Rate{Limit: 5, Window: 15 * time.Minute}) || !r.Enabled() {
		t.Fatalf("rate = %+v", r)
	}
}

func TestRetryAfter(t *testing.T) {
	tests := map[time.Duration]string{
		0:                "1",
		time.Microsecond: "1",
		time.Second:      "1",
		time.Second + 1:  "2",
		14*time.Minute + 59*time.Second + 500*time.Millisecond: "900",
	}
	for d, want := range tests {
		if got := retryAfter(d); got != want {
			t.Errorf("retryAfter(%v) = %s, want %s", d, got, want)
		}
	}
}

// humaCtx lets fakeCtx embed huma.Context without its field name clashing
// with the Context() method.
type humaCtx = huma.Context

// fakeCtx is the subset of huma.Context ClientIP reads.
type fakeCtx struct {
	humaCtx
	remote  string
	headers [][2]string
}

func (c fakeCtx) RemoteAddr() string { return c.remote }
func (c fakeCtx) EachHeader(cb func(name, value string)) {
	for _, h := range c.headers {
		cb(h[0], h[1])
	}
}

func TestClientIP(t *testing.T) {
	l, err := New(nil, slog.New(slog.DiscardHandler), []string{"10.0.0.0/8", "192.168.1.1", "fd00::/8"})
	if err != nil {
		t.Fatal(err)
	}
	xff := func(vs ...string) [][2]string {
		out := make([][2]string, 0, len(vs))
		for _, v := range vs {
			out = append(out, [2]string{"X-Forwarded-For", v})
		}
		return out
	}
	tests := []struct {
		name    string
		remote  string
		headers [][2]string
		want    string
	}{
		{"direct peer", "203.0.113.7:5555", nil, "203.0.113.7"},
		{"untrusted peer ignores XFF", "203.0.113.7:5555", xff("1.2.3.4"), "203.0.113.7"},
		{"trusted peer uses XFF", "10.1.2.3:5555", xff("198.51.100.9"), "198.51.100.9"},
		{"rightmost untrusted wins", "10.1.2.3:5555", xff("6.6.6.6, 198.51.100.9, 10.9.9.9"), "198.51.100.9"},
		{"multiple headers", "192.168.1.1:80", xff("6.6.6.6", "198.51.100.9"), "198.51.100.9"},
		{"all trusted", "10.1.2.3:5555", xff("10.4.4.4"), "10.4.4.4"},
		{"garbage hop stops the walk", "10.1.2.3:5555", xff("198.51.100.9, nonsense"), "10.1.2.3"},
		{"trusted peer without XFF", "10.1.2.3:5555", nil, "10.1.2.3"},
		{"ipv6 peer", "[2001:db8::1]:443", nil, "2001:db8::1"},
		{"trusted ipv6 proxy", "[fd00::1]:443", xff("2001:db8::2"), "2001:db8::2"},
		{"4in6 is unmapped", "[::ffff:203.0.113.7]:1", nil, "203.0.113.7"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := l.ClientIP(fakeCtx{remote: tt.remote, headers: tt.headers})
			if got != netip.MustParseAddr(tt.want) {
				t.Fatalf("ClientIP = %v, want %s", got, tt.want)
			}
		})
	}
}

func TestIPKeyBucketsIPv6By64(t *testing.T) {
	a := ipKey(netip.MustParseAddr("2001:db8:1:2::1"))
	b := ipKey(netip.MustParseAddr("2001:db8:1:2:ffff::9"))
	c := ipKey(netip.MustParseAddr("2001:db8:1:3::1"))
	if a != b || a == c {
		t.Fatalf("ipv6 keys: %s %s %s", a, b, c)
	}
	if got := ipKey(netip.MustParseAddr("203.0.113.7")); got != "203.0.113.7" {
		t.Fatalf("ipv4 key = %s", got)
	}
	if got := ipKey(netip.Addr{}); got != "unknown" {
		t.Fatalf("invalid key = %s", got)
	}
}

func TestNewRejectsBadProxy(t *testing.T) {
	if _, err := New(nil, slog.New(slog.DiscardHandler), []string{"nope"}); err == nil {
		t.Fatal("want error for an invalid trusted proxy")
	}
}

func TestRedisKeyHidesSubject(t *testing.T) {
	k := redisKey("email_start:key", "alice@example.com")
	if strings.Contains(k, "alice") || !strings.HasPrefix(k, keyPrefix+"email_start:key:") {
		t.Fatalf("key = %s", k)
	}
}
