package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/platform/config"
)

type fakePolicies struct {
	byApp map[uuid.UUID]privacy.Policy
	err   error
}

func (f fakePolicies) Redactor(_ context.Context, projectID, appID uuid.UUID) (*privacy.Redactor, error) {
	if f.err != nil {
		return nil, f.err
	}
	if projectID != testProject {
		return nil, fmt.Errorf("unexpected project %s", projectID)
	}
	return privacy.Compile(f.byApp[appID])
}

func newPrivacyEdge(t *testing.T, src PolicySource, sink *fakeSink) http.Handler {
	t.Helper()
	cfg := config.IngestConfig{MaxBodyBytes: 1 << 20, MaxRecordsPerRequest: 1000}
	e := New(fakeVerifier{}, fakeApps{}, sink, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if src != nil {
		e.WithPrivacy(src)
	}
	e.now = func() time.Time { return fixedNow }
	mux := http.NewServeMux()
	e.Register(mux)
	return mux
}

// rawRequest is a request record whose SDK masked nothing.
func rawRequest(t *testing.T) string {
	t.Helper()
	rec := map[string]any{
		"app_id": "storefront", "timestamp": "2026-10-22T11:59:00Z", "method": "POST", "path": "/login",
		"raw_path":         "/login?next=%2Fhome&access_token=abc123&email=ada%40example.com",
		"status_code":      200,
		"request_headers":  `{"authorization":"Bearer sk_live_abc","cookie":"sid=s3cr3t","x-api-key":"k","x-tenant":"acme","content-type":"application/json"}`,
		"response_headers": `{"set-cookie":"sid=new","content-type":"application/json"}`,
		"request_payload":  `{"email":"ada@example.com","password":"hunter2","card":{"card_number":"4111111111111111","cvv":"123","iban":"DE00"}}`,
		"response_payload": `{"token":"eyJhbGciOi","user":{"id":7}}`,
	}
	b, err := json.Marshal(map[string]any{"requests": []any{rec}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func assertNoSecrets(t *testing.T, where string, s string, secrets ...string) {
	t.Helper()
	for _, sec := range secrets {
		if strings.Contains(s, sec) {
			t.Errorf("%s still holds %q: %s", where, sec, s)
		}
	}
}

// The built-in defaults are enforced even when the SDK sent raw values and
// no policy is configured.
func TestEdgeEnforcesDefaultsOnRawRecords(t *testing.T) {
	for name, src := range map[string]PolicySource{"no policy source": nil, "empty policy": fakePolicies{}} {
		t.Run(name, func(t *testing.T) {
			sink := &fakeSink{}
			rec := post(t, newPrivacyEdge(t, src, sink), "/v1/requests", rawRequest(t), nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d %s", rec.Code, rec.Body)
			}
			row := sink.requests[0]
			if row.RawPath != "/login?next=%2Fhome&access_token=[redacted]&email=ada%40example.com" {
				t.Errorf("raw_path = %s", row.RawPath)
			}
			assertNoSecrets(t, "request headers", row.RequestHeaders, "sk_live_abc", "s3cr3t", `"k"`)
			assertNoSecrets(t, "response headers", row.ResponseHeaders, "sid=new")
			assertNoSecrets(t, "request payload", row.RequestPayload, "hunter2", "4111111111111111", `"123"`)
			assertNoSecrets(t, "response payload", row.ResponsePayload, "eyJhbGciOi")
			// Names stay visible, other values are kept.
			for _, keep := range []string{`"authorization":"[redacted]"`, `"x-tenant":"acme"`, `"content-type":"application/json"`} {
				if !strings.Contains(row.RequestHeaders, keep) {
					t.Errorf("request headers miss %s: %s", keep, row.RequestHeaders)
				}
			}
			if !strings.Contains(row.RequestPayload, `"iban":"DE00"`) || !strings.Contains(row.RequestPayload, `"email":"ada@example.com"`) {
				t.Errorf("request payload over-masked: %s", row.RequestPayload)
			}
		})
	}
}

func TestEdgeAppliesProjectAndAppPolicy(t *testing.T) {
	src := fakePolicies{byApp: map[uuid.UUID]privacy.Policy{testApp: {
		QueryParams: []string{"^email$"}, Headers: []string{"^x-tenant$"}, BodyFields: []string{"^iban$", "^email$"},
	}}}
	sink := &fakeSink{}
	rec := post(t, newPrivacyEdge(t, src, sink), "/v1/requests", rawRequest(t), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := sink.requests[0]
	if row.RawPath != "/login?next=%2Fhome&access_token=[redacted]&email=[redacted]" {
		t.Errorf("raw_path = %s", row.RawPath)
	}
	assertNoSecrets(t, "request headers", row.RequestHeaders, "acme", "sk_live_abc")
	assertNoSecrets(t, "request payload", row.RequestPayload, "DE00", "ada@example.com", "hunter2")
}

func TestEdgeMasksLogMessages(t *testing.T) {
	sink := &fakeSink{}
	body := `{"logs":[{"app_id":"storefront","timestamp":"2026-10-22T11:59:00Z","level":"error",
	  "message":"charge failed: api_key=sk_live_1 Authorization: Bearer abc.def amount=12",
	  "payload":"{\"password\":\"hunter2\",\"amount\":12}"}]}`
	rec := post(t, newPrivacyEdge(t, nil, sink), "/v1/logs", body, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	row := sink.logs[0]
	if row.Message != "charge failed: api_key=[redacted] Authorization: [redacted] amount=12" {
		t.Errorf("message = %q", row.Message)
	}
	if row.Payload != `{"password":"[redacted]","amount":12}` {
		t.Errorf("payload = %q", row.Payload)
	}
}

func TestEdgePolicyUnavailable(t *testing.T) {
	sink := &fakeSink{}
	rec := post(t, newPrivacyEdge(t, fakePolicies{err: errors.New("db down")}, sink), "/v1/requests", rawRequest(t), nil)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	if len(sink.requests) != 0 {
		t.Fatal("records stored without their privacy policy")
	}
}

// bench16KBRecord is a request record with a 16 KB JSON request body, a
// response body, both header maps and a query string, all with values the
// defaults mask.
func bench16KBRecord() requestRecord {
	var b strings.Builder
	b.WriteString(`{"order":{"id":"ord_1","customer":{"email":"ada@example.com","password":"hunter2"},"items":[`)
	for i := 0; b.Len() < 16<<10-64; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"sku":"SKU-%05d","qty":%d,"price":%d.99,"note":"gift wrap","card_number":"4111111111111111"}`, i, i%5+1, i%90+10)
	}
	b.WriteString(`]}}`)
	return requestRecord{
		AppID:           "storefront",
		Path:            "/orders",
		RawPath:         "/orders?page=2&api_key=k&sort=desc&token=t",
		RequestHeaders:  `{"authorization":"Bearer abc","content-type":"application/json","accept":"*/*","user-agent":"bench/1.0","x-request-id":"r-1","cookie":"sid=1"}`,
		ResponseHeaders: `{"content-type":"application/json","set-cookie":"sid=2","x-trace":"t"}`,
		RequestPayload:  b.String(),
		ResponsePayload: `{"id":"ord_1","status":"created","token":"tok"}`,
	}
}

// BenchmarkRedactRequest16KB is the edge's per-record privacy overhead for a
// 16 KB body (issue #562: p99 under 1 ms). Run with
// go test ./internal/ingest -run x -bench Redact -benchmem.
func BenchmarkRedactRequest16KB(b *testing.B) {
	red, err := privacy.Compile(privacy.Policy{QueryParams: []string{"^email$"}, Headers: []string{"^x-tenant$"}, BodyFields: []string{"^iban$"}})
	if err != nil {
		b.Fatal(err)
	}
	base := bench16KBRecord()
	b.SetBytes(int64(len(base.RequestPayload)))
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		rec := base
		redactRequest(red, &rec)
	}
}

// TestRedactRequest16KBUnderOneMillisecond guards the benchmark's budget
// with a wide margin: the p99 of 200 runs must stay under 1 ms.
func TestRedactRequest16KBUnderOneMillisecond(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	red := privacy.Default
	base := bench16KBRecord()
	if len(base.RequestPayload) < 16<<10-128 {
		t.Fatalf("body is %d bytes", len(base.RequestPayload))
	}
	const runs = 200
	took := make([]time.Duration, 0, runs)
	for range runs {
		rec := base
		start := time.Now()
		redactRequest(red, &rec)
		took = append(took, time.Since(start))
		if strings.Contains(rec.RequestPayload, "4111111111111111") {
			t.Fatal("card number not masked")
		}
	}
	slices.Sort(took)
	if p99 := took[runs*99/100-1]; p99 > time.Millisecond {
		t.Fatalf("p99 = %v, want < 1ms", p99)
	}
}
