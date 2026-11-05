package query

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/alerts"
)

func ptr[T any](v T) *T { return &v }

func status(err error) int {
	var se huma.StatusError
	if errors.As(err, &se) {
		return se.GetStatus()
	}
	return 0
}

func TestCheckRuleFields(t *testing.T) {
	ok := alertRuleBody{
		Environment: " production ", Name: " p95 too slow ", Metric: "p95", Condition: "gt",
		Threshold: 800, WindowS: 300, EveryS: ptr(int32(60)),
	}
	v, err := checkRuleFields(ok)
	if err != nil {
		t.Fatal(err)
	}
	if v.name != "p95 too slow" || v.environment != "production" || !v.enabled || v.cron != nil || *v.everyS != 60 {
		t.Fatalf("normalized = %+v", v)
	}

	ch := uuid.New()
	withCron := ok
	withCron.EveryS, withCron.Cron = nil, ptr(" */5 * * * * ")
	withCron.Enabled = ptr(false)
	withCron.ChannelIDs = []string{ch.String(), ch.String()}
	v, err = checkRuleFields(withCron)
	if err != nil {
		t.Fatal(err)
	}
	if *v.cron != "*/5 * * * *" || v.everyS != nil || v.enabled || len(v.channelIDs) != 1 || v.channelIDs[0] != ch {
		t.Fatalf("cron rule = %+v", v)
	}

	bad := map[string]func(b *alertRuleBody){
		"blank name":            func(b *alertRuleBody) { b.Name = "  " },
		"long name":             func(b *alertRuleBody) { b.Name = strings.Repeat("n", 129) },
		"blank environment":     func(b *alertRuleBody) { b.Environment = " " },
		"long description":      func(b *alertRuleBody) { b.Description = strings.Repeat("d", 1025) },
		"unknown metric":        func(b *alertRuleBody) { b.Metric = "p99" },
		"unknown condition":     func(b *alertRuleBody) { b.Condition = "eq" },
		"negative threshold":    func(b *alertRuleBody) { b.Threshold = -1 },
		"NaN threshold":         func(b *alertRuleBody) { b.Threshold = math.NaN() },
		"error rate above 1":    func(b *alertRuleBody) { b.Metric, b.Threshold = "error_rate", 5 },
		"apdex above 1":         func(b *alertRuleBody) { b.Metric, b.Threshold = "apdex", 1.5 },
		"window not minutes":    func(b *alertRuleBody) { b.WindowS = 90 },
		"window too short":      func(b *alertRuleBody) { b.WindowS = 0 },
		"no schedule":           func(b *alertRuleBody) { b.EveryS = nil },
		"both schedules":        func(b *alertRuleBody) { b.Cron = ptr("@hourly") },
		"empty cron":            func(b *alertRuleBody) { b.EveryS, b.Cron = nil, ptr(" ") },
		"bad cron":              func(b *alertRuleBody) { b.EveryS, b.Cron = nil, ptr("every minute") },
		"every too often":       func(b *alertRuleBody) { b.EveryS = ptr(int32(30)) },
		"notify after too long": func(b *alertRuleBody) { b.NotifyAfterS = 86401 },
		"negative resolve":      func(b *alertRuleBody) { b.ResolveAfterS = -1 },
		"bad channel id":        func(b *alertRuleBody) { b.ChannelIDs = []string{"slack"} },
		"too many channels": func(b *alertRuleBody) {
			for range 21 {
				b.ChannelIDs = append(b.ChannelIDs, uuid.NewString())
			}
		},
	}
	for name, mutate := range bad {
		b := ok
		mutate(&b)
		if _, err := checkRuleFields(b); status(err) != http.StatusUnprocessableEntity {
			t.Errorf("%s: err = %v, want 422", name, err)
		}
	}

	// Every metric accepts a zero threshold.
	for _, m := range alerts.Metrics {
		b := ok
		b.Metric, b.Threshold = string(m), 0
		if _, err := checkRuleFields(b); err != nil {
			t.Errorf("%s: %v", m, err)
		}
	}
}

func TestChannelConfig(t *testing.T) {
	secret := strings.Repeat("s", alerts.MinWebhookSecretLen)
	good := []struct {
		typ    alerts.ChannelType
		config map[string]any
	}{
		{alerts.ChannelEmail, map[string]any{"addresses": []any{"oncall@example.com", "dev@example.com"}}},
		{alerts.ChannelSlack, map[string]any{"webhook_url": "https://hooks.slack.com/services/T/B/x"}},
		{alerts.ChannelTeams, map[string]any{"webhook_url": "https://example.webhook.office.com/webhookb2/x"}},
		{alerts.ChannelWebhook, map[string]any{"url": "https://example.com/hooks/apilens", "secret": secret}},
	}
	for _, c := range good {
		got, err := channelConfig(c.typ, c.config)
		if err != nil {
			t.Errorf("%s %v: %v", c.typ, c.config, err)
			continue
		}
		if _, err := alerts.ParseChannelConfig(c.typ, got); err != nil {
			t.Errorf("%s: stored config %s does not parse: %v", c.typ, got, err)
		}
	}

	bad := []struct {
		typ    alerts.ChannelType
		config map[string]any
	}{
		{"pager", map[string]any{"url": "https://example.com"}},
		{alerts.ChannelEmail, nil},
		{alerts.ChannelEmail, map[string]any{}},
		{alerts.ChannelEmail, map[string]any{"addresses": []any{"not-an-address"}}},
		{alerts.ChannelEmail, map[string]any{"addresses": []any{"oncall@example.com"}, "cc": []any{"x@example.com"}}},
		{alerts.ChannelSlack, map[string]any{"webhook_url": "http://hooks.slack.com/services/x"}},
		{alerts.ChannelTeams, map[string]any{"webhook_url": 42}},
		{alerts.ChannelWebhook, map[string]any{"url": "https://example.com/x", "secret": "short"}},
		{alerts.ChannelWebhook, map[string]any{"url": "https://user:pw@example.com/x", "secret": secret}},
	}
	for _, c := range bad {
		_, err := channelConfig(c.typ, c.config)
		if status(err) != http.StatusUnprocessableEntity {
			t.Errorf("%s %v: err = %v, want 422", c.typ, c.config, err)
			continue
		}
		// The message never quotes a config value.
		for _, v := range []string{"hooks.slack.com", "user:pw", "x@example.com", "not-an-address"} {
			if strings.Contains(err.Error(), v) {
				t.Errorf("%s: error %q quotes the config", c.typ, err)
			}
		}
	}
}

func TestTestSenderPostsWebhooks(t *testing.T) {
	var got []byte
	code := http.StatusOK
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(code)
	}))
	defer srv.Close()
	// httptest listens on loopback, which the default poster refuses; its
	// client trusts the test certificate.
	sender := NewTestSender(nil, nil, alerts.NewPoster(alerts.PosterOptions{Client: srv.Client()}), "https://apilens.example.com/")
	cfg, _ := json.Marshal(map[string]string{"webhook_url": srv.URL})
	n := TestNotification{ProjectSlug: "shop", Type: alerts.ChannelSlack, Name: "#ops", Config: cfg}
	if err := sender.SendTest(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "Test notification from APILens") || !strings.Contains(string(got), "https://apilens.example.com/shop/incidents") {
		t.Fatalf("posted %s", got)
	}

	code = http.StatusNotFound
	err := sender.SendTest(context.Background(), n)
	var de *alerts.DeliveryError
	if !errors.As(err, &de) || de.Status != http.StatusNotFound || strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("404 send = %v", err)
	}

	// A config that no longer parses is refused before anything is sent.
	if err := sender.SendTest(context.Background(), TestNotification{Type: alerts.ChannelSlack, Config: []byte(`{}`)}); !errors.Is(err, alerts.ErrInvalidChannelConfig) {
		t.Fatalf("bad config = %v", err)
	}
}

func TestEventCursorRoundTrip(t *testing.T) {
	c := eventCursor{startedAt: time.Date(2026, 11, 5, 10, 30, 0, 123456000, time.UTC), id: uuid.New()}
	got, err := decodeEventCursor(c.encode())
	if err != nil || !got.startedAt.Equal(c.startedAt) || got.id != c.id {
		t.Fatalf("%+v round-tripped to %+v, %v", c, got, err)
	}
	// Not base64, no colon, bad micros, bad uuid.
	for _, bad := range []string{"!!", "bm8tY29sb24", "eHg6eQ", "MTI6bm90LWEtdXVpZA"} {
		if _, err := decodeEventCursor(bad); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}
