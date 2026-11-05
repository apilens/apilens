package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/apilens/apilens/internal/controlplane/capture"
	"github.com/apilens/apilens/internal/platform/config"
)

type fakeCapture struct {
	byApp map[uuid.UUID]capture.Policy
	err   error
	calls int
}

func (f *fakeCapture) Policy(_ context.Context, appID uuid.UUID) (capture.Policy, error) {
	f.calls++
	if f.err != nil {
		return capture.Policy{}, f.err
	}
	if p, ok := f.byApp[appID]; ok {
		return p, nil
	}
	return capture.Default(), nil
}

func newCapsEdge(t *testing.T, src CaptureSource, sink *fakeSink) (*Edge, http.Handler) {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 16 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	if src != nil {
		e.WithCapture(src)
	}
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return e, mux
}

func requestsBody(t *testing.T, recs ...map[string]any) string {
	t.Helper()
	for _, r := range recs {
		r["app_id"], r["timestamp"], r["method"], r["path"], r["status_code"] = "storefront", "2026-10-22T11:59:00Z", "POST", "/orders", 200
	}
	b, err := json.Marshal(map[string]any{"requests": recs})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func truncatedCount(e *Edge, field string) float64 {
	return promtest.ToFloat64(e.truncated.WithLabelValues(field))
}

// Each capped field is cut to its cap with the marker and counted; the other
// fields' counters stay at zero.
func TestCapsTruncateEachField(t *testing.T) {
	big := strings.Repeat("a", 100<<10)
	bigHeaders := `{"x-trace":"` + strings.Repeat("h", 10<<10) + `"}`
	cases := []struct {
		field string
		value string
		limit int
		get   func(sink *fakeSink) string
	}{
		{FieldRequestPayload, big, defaultMaxPayloadBytes, func(s *fakeSink) string { return s.requests[0].RequestPayload }},
		{FieldResponsePayload, big, defaultMaxPayloadBytes, func(s *fakeSink) string { return s.requests[0].ResponsePayload }},
		{FieldRequestHeaders, bigHeaders, maxHeaderBytes, func(s *fakeSink) string { return s.requests[0].RequestHeaders }},
		{FieldResponseHeaders, bigHeaders, maxHeaderBytes, func(s *fakeSink) string { return s.requests[0].ResponseHeaders }},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			sink := &fakeSink{}
			e, h := newCapsEdge(t, nil, sink)
			rec := post(t, h, "/v1/requests", requestsBody(t, map[string]any{tc.field: tc.value}), nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
			got := tc.get(sink)
			if want := tc.value[:tc.limit] + truncatedMarker; got != want {
				t.Errorf("%s: len %d, want the first %d bytes plus the marker", tc.field, len(got), tc.limit)
			}
			for _, f := range truncatedFields {
				want := 0.0
				if f == tc.field {
					want = 1
				}
				if c := truncatedCount(e, f); c != want {
					t.Errorf("apilens_ingest_truncated_total{field=%q} = %v, want %v", f, c, want)
				}
			}
		})
	}
}

func TestCapsLeaveSmallValues(t *testing.T) {
	sink := &fakeSink{}
	e, h := newCapsEdge(t, nil, sink)
	payload := strings.Repeat("p", defaultMaxPayloadBytes)
	headers := `{"content-type":"application/json"}`
	body := requestsBody(t, map[string]any{"request_payload": payload, "response_payload": `{"ok":true}`, "request_headers": headers})
	if rec := post(t, h, "/v1/requests", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := sink.requests[0]
	if row.RequestPayload != payload || row.ResponsePayload != `{"ok":true}` || row.RequestHeaders != headers {
		t.Errorf("values within the cap changed: %d %q %q", len(row.RequestPayload), row.ResponsePayload, row.RequestHeaders)
	}
	for _, f := range truncatedFields {
		if c := truncatedCount(e, f); c != 0 {
			t.Errorf("%s counted %v truncations", f, c)
		}
	}
}

// The app's max_payload_bytes replaces the default cap, both smaller and
// larger, and the policy is looked up once per app per batch.
func TestCapsUseAppPolicy(t *testing.T) {
	for _, limit := range []int{100, 200 << 10} {
		src := &fakeCapture{byApp: map[uuid.UUID]capture.Policy{testApp: {Enabled: true, SampleRate: 1, MaxPayloadBytes: &limit}}}
		sink := &fakeSink{}
		e, h := newCapsEdge(t, src, sink)
		big := strings.Repeat("b", 300<<10)
		body := requestsBody(t, map[string]any{"request_payload": big}, map[string]any{"response_payload": big})
		if rec := post(t, h, "/v1/requests", body, nil); rec.Code != http.StatusOK {
			t.Fatalf("got %d %s", rec.Code, rec.Body)
		}
		want := big[:limit] + truncatedMarker
		if sink.requests[0].RequestPayload != want || sink.requests[1].ResponsePayload != want {
			t.Errorf("limit %d: got lengths %d and %d", limit, len(sink.requests[0].RequestPayload), len(sink.requests[1].ResponsePayload))
		}
		if src.calls != 1 {
			t.Errorf("limit %d: policy looked up %d times, want 1", limit, src.calls)
		}
		if truncatedCount(e, FieldRequestPayload) != 1 || truncatedCount(e, FieldResponsePayload) != 1 {
			t.Errorf("limit %d: truncations not counted", limit)
		}
	}
}

// Without a stored cap, or with the policy store down, the default applies
// and the batch is still accepted.
func TestCapsFallBackToDefault(t *testing.T) {
	for name, src := range map[string]*fakeCapture{
		"no max_payload_bytes": {},
		"policy unavailable":   {err: errors.New("postgres down")},
	} {
		t.Run(name, func(t *testing.T) {
			sink := &fakeSink{}
			_, h := newCapsEdge(t, src, sink)
			big := strings.Repeat("c", 100<<10)
			if rec := post(t, h, "/v1/requests", requestsBody(t, map[string]any{"request_payload": big}), nil); rec.Code != http.StatusOK {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
			if got := sink.requests[0].RequestPayload; got != big[:defaultMaxPayloadBytes]+truncatedMarker {
				t.Errorf("len %d, want the default cap", len(got))
			}
		})
	}
}

// Sensitive headers are masked before the cap whatever the SDK sent, so
// neither a value before the cut point nor a fragment past it is stored.
func TestCapsRedactSensitiveHeadersBeforeCutting(t *testing.T) {
	sink := &fakeSink{}
	_, h := newCapsEdge(t, nil, sink)
	headers := `{"authorization":"Bearer sk_live_abc","x-pad":"` + strings.Repeat("z", 9<<10) + `","cookie":"sid=s3cr3t"}`
	if rec := post(t, h, "/v1/requests", requestsBody(t, map[string]any{"request_headers": headers}), nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	got := sink.requests[0].RequestHeaders
	assertNoSecrets(t, "request headers", got, "sk_live_abc", "s3cr3t")
	if !strings.HasPrefix(got, `{"authorization":"[redacted]"`) || !strings.HasSuffix(got, truncatedMarker) || len(got) != maxHeaderBytes+len(truncatedMarker) {
		t.Errorf("headers not redacted then capped: %.60s... (len %d)", got, len(got))
	}
}

func TestCapBytes(t *testing.T) {
	if got, cut := capBytes("hello", 5); got != "hello" || cut {
		t.Errorf("at the cap: %q %v", got, cut)
	}
	if got, cut := capBytes("hello", 3); got != "hel"+truncatedMarker || !cut {
		t.Errorf("over the cap: %q %v", got, cut)
	}
	// A cut inside a multi-byte rune backs off to its start.
	if got, _ := capBytes("aé", 2); got != "a"+truncatedMarker {
		t.Errorf("split rune: %q", got)
	}
	if got, _ := capBytes("€€", 4); got != "€"+truncatedMarker || !utf8.ValidString(got) {
		t.Errorf("split rune: %q", got)
	}
	if got, cut := capBytes("a\xffb", 10); got != "a�b" || cut {
		t.Errorf("invalid UTF-8: %q %v", got, cut)
	}
}
