package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
)

func TestValidateHealthCheckURL(t *testing.T) {
	for _, c := range []struct {
		raw          string
		allowPrivate bool
		want         string // "" means refused
	}{
		{"https://api.example.com/healthz", false, "https://api.example.com/healthz"},
		{"  http://api.example.com:8080/health?deep=1 ", false, "http://api.example.com:8080/health?deep=1"},
		{"https://203.0.113.10/health", false, "https://203.0.113.10/health"},
		// Not http(s), no host, credentials, fragments.
		{"ftp://api.example.com/", false, ""},
		{"file:///etc/passwd", false, ""},
		{"gopher://api.example.com:70/", false, ""},
		{"api.example.com/health", false, ""},
		{"https://", false, ""},
		{"https://user:pass@api.example.com/", false, ""},
		{"https://api.example.com/#frag", false, ""},
		{"https://api.example.com:0/", false, ""},
		{"https://api.example.com:70000/", false, ""},
		{"https://api.example.com/" + strings.Repeat("a", MaxHealthCheckURLLen), false, ""},
		// SSRF: loopback, private, link-local (cloud metadata), CGNAT,
		// unspecified, IPv6 and IPv4-mapped forms, localhost names.
		{"http://127.0.0.1/", false, ""},
		{"http://127.1.2.3:9000/admin", false, ""},
		{"http://10.0.0.5/", false, ""},
		{"http://172.16.4.1/", false, ""},
		{"http://192.168.1.1/", false, ""},
		{"http://169.254.169.254/latest/meta-data/", false, ""},
		{"http://100.64.0.1/", false, ""},
		{"http://0.0.0.0:8080/", false, ""},
		{"http://[::1]/", false, ""},
		{"http://[fe80::1]/", false, ""},
		{"http://[fd00::1]/", false, ""},
		{"http://[::ffff:127.0.0.1]/", false, ""},
		{"http://localhost:8080/", false, ""},
		{"http://LOCALHOST./", false, ""},
		{"http://api.localhost/", false, ""},
		// A self-hosted install that allows private networks.
		{"http://10.0.0.5:8080/healthz", true, "http://10.0.0.5:8080/healthz"},
		{"http://localhost:8080/", true, "http://localhost:8080/"},
		{"http://[::1]:8080/", true, "http://[::1]:8080/"},
		// Never other schemes or credentials, even then.
		{"file:///etc/passwd", true, ""},
		{"http://user:pass@10.0.0.5/", true, ""},
	} {
		got, err := ValidateHealthCheckURL(c.raw, c.allowPrivate)
		if c.want == "" {
			var ue *HealthCheckURLError
			if err == nil || !errors.As(err, &ue) {
				t.Errorf("%q (private %v) = %q, %v; want refused", c.raw, c.allowPrivate, got, err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%q (private %v) = %q, %v; want %q", c.raw, c.allowPrivate, got, err, c.want)
		}
	}
}

// TestProbeSSRFGuard: the default client refuses to connect to a non-public
// address, including a name that resolves to one, without retrying and
// without the request reaching it; allowing private networks reaches it.
func TestProbeSSRFGuard(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	ctx := context.Background()

	guarded := NewProber(ProberOptions{RetryDelay: time.Millisecond})
	for _, target := range []string{srv.URL + "/healthz", "http://localhost:" + port + "/healthz"} {
		r := guarded.Probe(ctx, target, http.StatusOK, nil, testNow)
		if r.OK || r.Error != "address not allowed (not a public address)" || r.Attempts != 1 || r.StatusCode != 0 {
			t.Errorf("%s: guarded probe = %+v", target, r)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("guarded probes reached the server %d times", n)
	}

	open := NewProber(ProberOptions{AllowPrivateNetworks: true, RetryDelay: time.Millisecond})
	if r := open.Probe(ctx, srv.URL+"/healthz", http.StatusOK, nil, testNow); !r.OK || r.StatusCode != http.StatusOK || r.Attempts != 1 {
		t.Errorf("private networks allowed: probe = %+v", r)
	}
}

// TestProbeNoRedirects: a redirect is the response, never followed (it
// could lead to an address the guard was not asked about).
func TestProbeNoRedirects(t *testing.T) {
	var followed atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/internal", http.StatusFound)
	})
	mux.HandleFunc("/internal", func(http.ResponseWriter, *http.Request) { followed.Store(true) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	p := NewProber(ProberOptions{AllowPrivateNetworks: true, RetryDelay: time.Millisecond})
	r := p.Probe(context.Background(), srv.URL+"/healthz", http.StatusOK, nil, testNow)
	if r.OK || r.StatusCode != http.StatusFound || r.Error != "unexpected status 302" {
		t.Errorf("probe = %+v", r)
	}
	if followed.Load() {
		t.Error("redirect followed")
	}
	if r := p.Probe(context.Background(), srv.URL+"/healthz", http.StatusFound, nil, testNow); !r.OK {
		t.Errorf("expecting 302: probe = %+v", r)
	}
}

func TestProbeRetry(t *testing.T) {
	ctx := context.Background()
	p := NewProber(ProberOptions{AllowPrivateNetworks: true, RetryDelay: time.Millisecond, Timeout: 200 * time.Millisecond})

	t.Run("passes on the retry", func(t *testing.T) {
		var n atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if n.Add(1) == 1 {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			_, _ = w.Write([]byte("ok"))
		}))
		t.Cleanup(srv.Close)
		r := p.Probe(ctx, srv.URL, http.StatusOK, nil, testNow)
		if !r.OK || r.Attempts != 2 || r.Error != "" || r.BodySnippet != "" || !r.CheckedAt.Equal(testNow) {
			t.Errorf("probe = %+v", r)
		}
	})

	t.Run("fails twice: the last attempt's details", func(t *testing.T) {
		var n atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			n.Add(1)
			if r.Header.Get("User-Agent") != healthCheckUserAgent || r.Method != http.MethodGet {
				t.Errorf("request %s %q", r.Method, r.Header.Get("User-Agent"))
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"down","db":{"password":"hunter2","host":"db-1"}}`))
		}))
		t.Cleanup(srv.Close)
		r := p.Probe(ctx, srv.URL, http.StatusOK, nil, testNow)
		if r.OK || r.Attempts != 2 || n.Load() != 2 || r.StatusCode != 503 || r.ExpectedStatus != 200 ||
			r.Error != "unexpected status 503" || r.LatencyMS <= 0 {
			t.Errorf("probe = %+v", r)
		}
		if r.BodySnippet != `{"status":"down","db":{"password":"[redacted]","host":"db-1"}}` || r.BodyTruncated {
			t.Errorf("body = %q (truncated %v)", r.BodySnippet, r.BodyTruncated)
		}
	})

	t.Run("timeout, retried", func(t *testing.T) {
		var n atomic.Int32
		release := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			n.Add(1)
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}))
		t.Cleanup(func() { close(release); srv.Close() })
		r := p.Probe(ctx, srv.URL, http.StatusOK, nil, testNow)
		if r.OK || r.Error != "timeout" || r.Attempts != 2 || n.Load() != 2 || r.LatencyMS < 150 {
			t.Errorf("probe = %+v", r)
		}
	})

	t.Run("connection refused", func(t *testing.T) {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := l.Addr().String()
		_ = l.Close()
		r := p.Probe(ctx, "http://"+addr+"/", http.StatusOK, nil, testNow)
		if r.OK || r.Error != "connection refused" || r.Attempts != 2 {
			t.Errorf("probe = %+v", r)
		}
	})
}

func TestBodySnippet(t *testing.T) {
	red := privacy.Default
	if s, tr := bodySnippet([]byte(`token=abc&page=2`), red); s != "token=[redacted]&page=2" || tr {
		t.Errorf("form body = %q, %v", s, tr)
	}
	// Masked before it is cut: a secret past the snippet is never half kept.
	long := `{"pad":"` + strings.Repeat("x", 2000) + `","secret":"s3cr3t"}`
	s, tr := bodySnippet([]byte(long), red)
	if len(s) != MaxBodySnippet || !tr || strings.Contains(s, "s3cr3t") {
		t.Errorf("long body: len %d, truncated %v", len(s), tr)
	}
	// Cut on a character boundary.
	multi := strings.Repeat("é", MaxBodySnippet) // 2 bytes each
	s, tr = bodySnippet([]byte(multi), red)
	if !utf8.ValidString(s) || len(s) > MaxBodySnippet || len(s) < MaxBodySnippet-1 || !tr {
		t.Errorf("multibyte body: len %d, valid %v, truncated %v", len(s), utf8.ValidString(s), tr)
	}
	// Binary bodies are left out.
	if s, _ := bodySnippet([]byte{0x1f, 0x8b, 0xff, 0xfe, 0x00}, red); s != "" {
		t.Errorf("binary body = %q", s)
	}
	// A body over the read limit is truncated even when it masks short.
	huge := []byte(strings.Repeat("a", healthCheckReadLimit+1))
	if _, tr := bodySnippet(huge, red); !tr {
		t.Error("body over the read limit not truncated")
	}
}

func TestHealthCheckStep(t *testing.T) {
	for _, c := range []struct {
		name   string
		prev   UptimeStatus
		ok     bool
		want   UptimeStatus
		action Action
	}{
		{"up, passes", UptimeUp, true, UptimeUp, ActionNone},
		{"up, fails: down", UptimeUp, false, UptimeDown, ActionTrigger},
		{"down, still failing", UptimeDown, false, UptimeDown, ActionNone},
		{"down, passes: resolved", UptimeDown, true, UptimeUp, ActionResolve},
		{"unknown status is up", "paused", false, UptimeDown, ActionTrigger},
	} {
		got, action := HealthCheckStep(c.prev, c.ok)
		if got != c.want || action != c.action {
			t.Errorf("%s: = %s, %s; want %s, %s", c.name, got, action, c.want, c.action)
		}
	}
}

// fakeHealthTx is an in-memory HealthCheckTxStore.
type fakeHealthTx struct {
	check  *db.HealthCheck
	events []db.AlertEvent
	failAt string
}

func (f *fakeHealthTx) LockHealthCheck(_ context.Context, id uuid.UUID) (db.HealthCheck, error) {
	if f.check == nil || f.check.ID != id || !f.check.Enabled {
		return db.HealthCheck{}, pgx.ErrNoRows
	}
	return *f.check, nil
}

func (f *fakeHealthTx) RecordHealthCheckResult(_ context.Context, a db.RecordHealthCheckResultParams) error {
	if f.failAt == "record" {
		return errors.New("boom")
	}
	at := a.CheckedAt
	f.check.Status, f.check.StatusSince, f.check.CheckedAt, f.check.LastResult = a.Status, a.StatusSince, &at, a.LastResult
	return nil
}

func (f *fakeHealthTx) GetOpenHealthCheckEvent(_ context.Context, id uuid.UUID) (db.AlertEvent, error) {
	for _, e := range f.events {
		if e.HealthCheckID != nil && *e.HealthCheckID == id && e.State == "triggered" {
			return e, nil
		}
	}
	return db.AlertEvent{}, pgx.ErrNoRows
}

func (f *fakeHealthTx) OpenHealthCheckEvent(_ context.Context, a db.OpenHealthCheckEventParams) (db.AlertEvent, error) {
	id := a.HealthCheckID
	e := db.AlertEvent{ID: a.ID, Kind: "health_check", HealthCheckID: &id, State: "triggered", Value: a.Value, StartedAt: a.StartedAt, Details: a.Details}
	f.events = append(f.events, e)
	return e, nil
}

func (f *fakeHealthTx) ResolveAlertEvent(_ context.Context, a db.ResolveAlertEventParams) (db.AlertEvent, error) {
	for i, e := range f.events {
		if e.ID == a.ID && e.State == "triggered" {
			end := a.EndedAt
			f.events[i].State, f.events[i].EndedAt = "resolved", &end
			return f.events[i], nil
		}
	}
	return db.AlertEvent{}, pgx.ErrNoRows
}

func TestRecordHealthCheck(t *testing.T) {
	ctx := context.Background()
	checkID := uuid.New()
	const target = "https://api.example.com/healthz"
	newCheck := func() *fakeHealthTx {
		return &fakeHealthTx{check: &db.HealthCheck{
			ID: checkID, ProjectID: testProjectID, AppID: testAppID, Environment: "production",
			Url: target, ExpectedStatus: 200, Enabled: true, Status: "up", StatusSince: testStart,
		}}
	}
	tgt := HealthCheckTarget{ID: checkID, ProjectID: testProjectID, AppID: testAppID, URL: target, ExpectedStatus: 200}
	at := func(m int) time.Time { return testStart.Add(time.Duration(m) * time.Minute) }
	pass := func(m int) HealthCheckResult {
		return HealthCheckResult{OK: true, StatusCode: 200, ExpectedStatus: 200, LatencyMS: 12, Attempts: 1, CheckedAt: at(m)}
	}
	fail := func(m int) HealthCheckResult {
		return HealthCheckResult{StatusCode: 503, ExpectedStatus: 200, LatencyMS: 41.5, Error: "unexpected status 503",
			BodySnippet: `{"password":"[redacted]"}`, Attempts: 2, CheckedAt: at(m)}
	}

	t.Run("fail opens an event with the request details; pass resolves it", func(t *testing.T) {
		f := newCheck()
		if tr, err := recordHealthCheck(ctx, f, tgt, pass(1)); err != nil || tr.Action != ActionNone || tr.Event != nil {
			t.Fatalf("pass = %+v, %v", tr, err)
		}
		tr, err := recordHealthCheck(ctx, f, tgt, fail(2))
		if err != nil || tr.Action != ActionTrigger || tr.Event == nil || tr.To != UptimeDown {
			t.Fatalf("fail = %+v, %v", tr, err)
		}
		var got HealthCheckResult
		if err := json.Unmarshal(tr.Event.Details, &got); err != nil {
			t.Fatal(err)
		}
		if got.StatusCode != 503 || got.BodySnippet != `{"password":"[redacted]"}` || got.Attempts != 2 || !got.CheckedAt.Equal(at(2)) {
			t.Errorf("details = %+v", got)
		}
		if tr.Event.Value != 41.5 || !tr.Event.StartedAt.Equal(at(2)) {
			t.Errorf("event = %+v", tr.Event)
		}
		if f.check.Status != "down" || !f.check.StatusSince.Equal(at(2)) || string(f.check.LastResult) != string(tr.Event.Details) {
			t.Errorf("check = %+v", f.check)
		}
		// Still failing: no second event.
		if tr, err := recordHealthCheck(ctx, f, tgt, fail(3)); err != nil || tr.Action != ActionNone || len(f.events) != 1 {
			t.Fatalf("still failing = %+v, %v, %d events", tr, err, len(f.events))
		}
		tr, err = recordHealthCheck(ctx, f, tgt, pass(4))
		if err != nil || tr.Action != ActionResolve || tr.Event == nil || tr.Event.State != "resolved" || !tr.Event.EndedAt.Equal(at(4)) {
			t.Fatalf("pass = %+v, %v", tr, err)
		}
		if f.check.Status != "up" || !f.check.StatusSince.Equal(at(4)) {
			t.Errorf("check = %+v", f.check)
		}
	})

	t.Run("replayed probe changes nothing", func(t *testing.T) {
		f := newCheck()
		if _, err := recordHealthCheck(ctx, f, tgt, fail(2)); err != nil {
			t.Fatal(err)
		}
		for _, m := range []int{2, 1} {
			tr, err := recordHealthCheck(ctx, f, tgt, pass(m))
			if err != nil || !tr.Skipped || tr.Event != nil || f.check.Status != "down" {
				t.Errorf("replay at %d = %+v, %v", m, tr, err)
			}
		}
	})

	t.Run("deleted, disabled or changed since listed: skipped", func(t *testing.T) {
		f := newCheck()
		f.check.Enabled = false
		if tr, err := recordHealthCheck(ctx, f, tgt, fail(1)); err != nil || !tr.Skipped || len(f.events) != 0 {
			t.Errorf("disabled = %+v, %v", tr, err)
		}
		f = newCheck()
		f.check.Url = "https://api.example.com/v2/healthz"
		if tr, err := recordHealthCheck(ctx, f, tgt, fail(1)); err != nil || !tr.Skipped || len(f.events) != 0 {
			t.Errorf("url changed = %+v, %v", tr, err)
		}
		f = newCheck()
		f.check.ExpectedStatus = 204
		if tr, err := recordHealthCheck(ctx, f, tgt, fail(1)); err != nil || !tr.Skipped {
			t.Errorf("expected status changed = %+v, %v", tr, err)
		}
		f = &fakeHealthTx{}
		if tr, err := recordHealthCheck(ctx, f, tgt, fail(1)); err != nil || !tr.Skipped {
			t.Errorf("deleted = %+v, %v", tr, err)
		}
	})

	t.Run("going down reuses an open event", func(t *testing.T) {
		f := newCheck()
		id := checkID
		open := db.AlertEvent{ID: uuid.New(), Kind: "health_check", HealthCheckID: &id, State: "triggered", StartedAt: at(0)}
		f.events = []db.AlertEvent{open}
		tr, err := recordHealthCheck(ctx, f, tgt, fail(1))
		if err != nil || tr.Event == nil || tr.Event.ID != open.ID || len(f.events) != 1 {
			t.Errorf("= %+v, %v", tr, err)
		}
	})

	t.Run("failed write returns an error", func(t *testing.T) {
		f := newCheck()
		f.failAt = "record"
		if _, err := recordHealthCheck(ctx, f, tgt, fail(1)); err == nil {
			t.Error("no error")
		}
	})
}

// healthRow is the GetHealthCheckEventNotification row of the sample
// health check event, open or resolved.
func healthRow(kind NotificationKind, channels ...uuid.UUID) db.GetHealthCheckEventNotificationRow {
	details, _ := json.Marshal(HealthCheckResult{
		StatusCode: 503, ExpectedStatus: 200, LatencyMS: 41.2, Error: "unexpected status 503",
		BodySnippet: `{"status":"degraded","password":"[redacted]"}`, BodyTruncated: true, Attempts: 2, CheckedAt: testStart,
	})
	row := db.GetHealthCheckEventNotificationRow{
		ID: testEventID, State: "triggered", Value: 41.2, StartedAt: testStart, Details: details,
		HealthCheckID: uuid.MustParse("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"),
		Url:           "https://api.example.com/healthz?token=abc&deep=1", ExpectedStatus: 200, Enabled: true,
		Environment: "production", ProjectID: testProjectID, AppID: testAppID, AppName: "storefront",
		ProjectSlug: "shop", ChannelIds: channels,
	}
	if kind == NotifyResolved {
		row.State = "resolved"
		end := testEnd
		row.EndedAt = &end
	}
	return row
}

func TestHealthCheckNotificationText(t *testing.T) {
	n := HealthCheckNotificationFromRow(NotifyTriggered, healthRow(NotifyTriggered), testUIURL)
	if n.URL != "https://app.example.com/shop/settings/health-checks" {
		t.Errorf("URL = %s", n.URL)
	}
	if got, want := n.Title(), "Health check failing: storefront (production)"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
	want := "GET https://api.example.com/healthz?token=[redacted]&deep=1 on storefront (production) failed after 2 attempts: HTTP 503 (expected 200)."
	if got := n.Summary(); got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
	r := HealthCheckNotificationFromRow(NotifyResolved, healthRow(NotifyResolved), testUIURL)
	if r.Title() != "Health check passing: storefront (production)" ||
		r.Summary() != "GET https://api.example.com/healthz?token=[redacted]&deep=1 on storefront (production) answers 200 again." {
		t.Errorf("resolved = %q / %q", r.Title(), r.Summary())
	}
	if n.WebhookEventType() != "health_check.failing" || r.WebhookEventType() != "health_check.passing" {
		t.Errorf("webhook types = %s, %s", n.WebhookEventType(), r.WebhookEventType())
	}
	for _, nn := range []Notification{n, r} {
		for _, f := range nn.facts() {
			if f.title == "Metric" || f.title == "Threshold" || f.title == "Window" || strings.Contains(f.value, "abc") {
				t.Errorf("fact %q = %q", f.title, f.value)
			}
		}
	}
	b, err := n.WebhookPayload()
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Rule        any `json:"rule"`
		Event       struct{ Kind string }
		HealthCheck struct {
			URL     string
			Failure *HealthCheckResult
		} `json:"health_check"`
	}
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatal(err)
	}
	if body.Rule != nil || body.Event.Kind != "health_check" || body.HealthCheck.Failure == nil ||
		body.HealthCheck.Failure.StatusCode != 503 || strings.Contains(body.HealthCheck.URL, "abc") {
		t.Errorf("webhook = %s", b)
	}
	// Retries are reported as such, a single attempt too.
	one := healthRow(NotifyTriggered)
	one.Details, _ = json.Marshal(HealthCheckResult{Error: "address not allowed (not a public address)", Attempts: 1})
	if s := HealthCheckNotificationFromRow(NotifyTriggered, one, testUIURL).Summary(); !strings.HasSuffix(s, "failed on 1 attempt: address not allowed (not a public address).") {
		t.Errorf("one attempt: %q", s)
	}
}

// TestHealthCheckChannelContracts records every channel's health check
// payloads in testdata/notify.
func TestHealthCheckChannelContracts(t *testing.T) {
	for _, typ := range []ChannelType{ChannelSlack, ChannelTeams, ChannelWebhook} {
		for _, kind := range []NotificationKind{NotifyTriggered, NotifyResolved} {
			t.Run(string(typ)+"_"+string(kind), func(t *testing.T) {
				srv := newRecorder(t)
				h := newHarness(t, srv.Client())
				config := `{"webhook_url":"` + srv.URL + `/services/T000/B000/XXXX"}`
				if typ == ChannelWebhook {
					config = `{"url":"` + srv.URL + `/hooks/apilens","secret":"whsec_0123456789abcdef"}`
				}
				ch := h.addChannel(t, typ, config)
				h.store.health[testEventID] = healthRow(kind, ch)
				if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: kind}, 1); err != nil {
					t.Fatal(err)
				}
				reqs := srv.requests()
				if len(reqs) != 1 {
					t.Fatalf("requests = %d, want 1", len(reqs))
				}
				checkGolden(t, "health_check_"+string(typ)+"_"+string(kind)+".json", reqs[0])
			})
		}
	}
}

func TestHealthCheckEmailContract(t *testing.T) {
	renderer, err := email.DefaultRenderer(email.WithPublicUIURL(testUIURL))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []NotificationKind{NotifyTriggered, NotifyResolved} {
		t.Run(string(kind), func(t *testing.T) {
			h := newHarness(t, nil)
			ch := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com"]}`)
			h.store.health[testEventID] = healthRow(kind, ch)
			if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: kind}, 1); err != nil {
				t.Fatal(err)
			}
			jobs := h.jobs.inserted()
			if len(jobs) != 1 {
				t.Fatalf("jobs = %d, want 1", len(jobs))
			}
			b, _ := json.Marshal(jobs[0].(email.SendArgs))
			var stored email.SendArgs
			if err := json.Unmarshal(b, &stored); err != nil {
				t.Fatal(err)
			}
			msg, err := renderer.Render(stored.Template, stored.To, stored.Data)
			if err != nil {
				t.Fatalf("render %s: %v", stored.Template, err)
			}
			if !strings.Contains(msg.Text, "GET api.example.com/healthz?token=[redacted]&deep=1") || strings.Contains(msg.Text, "abc") {
				t.Errorf("email:\n%s", msg.Text)
			}
			if kind == NotifyTriggered && !strings.Contains(msg.Text, `"password":"[redacted]"`) {
				t.Errorf("no response body in:\n%s", msg.Text)
			}
			checkGolden(t, "health_check_email_"+string(kind)+".json", jobs)
		})
	}
}

// TestHealthCheckDisabledSendsNothing: a disabled check's events fan out to
// no channel.
func TestHealthCheckDisabledSendsNothing(t *testing.T) {
	h := newHarness(t, nil)
	mail := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com"]}`)
	row := healthRow(NotifyTriggered, mail)
	h.store.health[testEventID] = row
	ctx := context.Background()
	if n, err := h.n.FanOut(ctx, NotifyArgs{EventID: testEventID, Notification: NotifyTriggered}); err != nil || n != 1 {
		t.Fatalf("enabled FanOut = %d, %v; want 1", n, err)
	}
	row.Enabled = false
	h.store.health[testEventID] = row
	if n, err := h.n.FanOut(ctx, NotifyArgs{EventID: testEventID, Notification: NotifyTriggered}); err != nil || n != 0 {
		t.Errorf("disabled FanOut = %d, %v; want 0", n, err)
	}
}
