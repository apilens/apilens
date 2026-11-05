package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
)

var update = flag.Bool("update", false, "rewrite testdata/notify from the current payloads")

const testUIURL = "https://app.example.com/"

var (
	testEventID   = uuid.MustParse("0b9c3a52-6a3e-4f0e-9d0b-6c2f1e7d8a41")
	testRuleID    = uuid.MustParse("5d1e0c44-2f6b-4a8e-b0a3-91c7e2d4f600")
	testProjectID = uuid.MustParse("7a2b9e10-4c3d-4e5f-8a6b-0c1d2e3f4a5b")
	testAppID     = uuid.MustParse("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b")
	testStart     = time.Date(2026, 11, 4, 9, 30, 0, 0, time.UTC)
	testEnd       = time.Date(2026, 11, 4, 10, 5, 0, 0, time.UTC)
	// The clock webhook timestamps are signed with.
	testNow = time.Date(2026, 11, 4, 10, 6, 0, 0, time.UTC)
)

// eventRow is the GetAlertEventNotification row of the sample event, open
// or resolved.
func eventRow(kind NotificationKind, channels ...uuid.UUID) db.GetAlertEventNotificationRow {
	latest := 0.012
	row := db.GetAlertEventNotificationRow{
		ID: testEventID, State: "triggered", Value: 0.125, StartedAt: testStart,
		RuleID: testRuleID, ProjectID: testProjectID, RuleName: "Checkout <5xx> rate & more",
		Environment: "production", Metric: string(MetricErrorRate), Condition: string(ConditionGT),
		Threshold: 0.05, WindowS: 300, ChannelIds: channels,
		AppID: testAppID, AppName: "storefront", ProjectSlug: "shop", LatestValue: &latest,
	}
	if kind == NotifyResolved {
		row.State = "resolved"
		end := testEnd
		row.EndedAt = &end
	}
	return row
}

func TestNotificationText(t *testing.T) {
	n := NotificationFromRow(NotifyTriggered, eventRow(NotifyTriggered), testUIURL)
	if got, want := n.URL, "https://app.example.com/shop/incidents?event="+testEventID.String(); got != want {
		t.Errorf("URL = %s, want %s", got, want)
	}
	if got, want := n.Summary(), "Error rate on storefront (production) is 12.5%, > 5% over the last 5 minutes."; got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
	r := NotificationFromRow(NotifyResolved, eventRow(NotifyResolved), testUIURL)
	if r.ValueText() != "1.2%" || r.EndedAt == nil || !r.EndedAt.Equal(testEnd) {
		t.Errorf("resolved = %+v", r)
	}
	for _, c := range []struct {
		m    Metric
		v    float64
		want string
	}{
		{MetricTraffic, 1200, "1200"},
		{MetricErrors, 3, "3"},
		{MetricErrorRate, 0.5, "50%"},
		{MetricErrorRate, 0.00126, "0.13%"},
		{MetricP95, 412.26, "412.3 ms"},
		{MetricApdex, 0.8, "0.80"},
		{MetricUniqueConsumers, 42, "42"},
	} {
		if got := FormatValue(c.m, &c.v); got != c.want {
			t.Errorf("FormatValue(%s, %v) = %s, want %s", c.m, c.v, got, c.want)
		}
	}
	if FormatValue(MetricP50, nil) != "no data" {
		t.Error("nil value")
	}
	for s, want := range map[int32]string{60: "1 minute", 300: "5 minutes", 3600: "1 hour", 7200: "2 hours", 90: "90 seconds"} {
		if got := FormatWindow(s); got != want {
			t.Errorf("FormatWindow(%d) = %s, want %s", s, got, want)
		}
	}
}

func TestParseChannelConfig(t *testing.T) {
	ok := map[ChannelType]string{
		ChannelEmail:   `{"addresses":["oncall@example.com","ops@example.com"]}`,
		ChannelSlack:   `{"webhook_url":"https://hooks.slack.com/services/T000/B000/XXXX"}`,
		ChannelTeams:   `{"webhook_url":"https://example.webhook.office.com/webhookb2/abc"}`,
		ChannelWebhook: `{"url":"https://hooks.example.com/apilens","secret":"0123456789abcdef"}`,
	}
	for typ, raw := range ok {
		if _, err := ParseChannelConfig(typ, json.RawMessage(raw)); err != nil {
			t.Errorf("%s: %v", typ, err)
		}
	}
	const secretish = "s3cr3t-token-value"
	bad := []struct {
		typ ChannelType
		raw string
	}{
		{ChannelEmail, `{"addresses":[]}`},
		{ChannelEmail, `{"addresses":["Ada <ada@example.com>"]}`},
		{ChannelEmail, `{"addresses":["` + secretish + `"]}`},
		{ChannelEmail, `{"to":["ada@example.com"]}`},
		{ChannelSlack, `{"webhook_url":"http://hooks.slack.com/services/` + secretish + `"}`},
		{ChannelSlack, `{"webhook_url":"https://user:` + secretish + `@hooks.slack.com/x"}`},
		{ChannelTeams, `{}`},
		{ChannelWebhook, `{"url":"https://hooks.example.com/x","secret":"short"}`},
		{ChannelWebhook, `{"url":"ftp://hooks.example.com/` + secretish + `","secret":"0123456789abcdef"}`},
		{ChannelWebhook, `"` + secretish + `"`},
		{"sms", `{}`},
	}
	for _, c := range bad {
		_, err := ParseChannelConfig(c.typ, json.RawMessage(c.raw))
		if !errors.Is(err, ErrInvalidChannelConfig) {
			t.Errorf("%s %s: err = %v, want ErrInvalidChannelConfig", c.typ, c.raw, err)
			continue
		}
		if strings.Contains(err.Error(), secretish) {
			t.Errorf("%s: error quotes the config: %v", c.typ, err)
		}
	}
}

// recorded is one captured HTTP request, as stored in testdata/notify.
type recorded struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
}

// recorder is a TLS server that records every request and answers status.
type recorder struct {
	*httptest.Server
	mu     sync.Mutex
	reqs   []recorded
	raw    [][]byte
	hdrs   []http.Header
	status int
}

func newRecorder(t *testing.T) *recorder {
	t.Helper()
	r := &recorder{status: http.StatusOK}
	r.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		h := map[string]string{}
		for _, k := range []string{"Content-Type", "User-Agent", HeaderWebhookEvent, HeaderWebhookDelivery, HeaderWebhookTimestamp, HeaderWebhookSignature} {
			if v := req.Header.Get(k); v != "" {
				h[k] = v
			}
		}
		r.mu.Lock()
		r.reqs = append(r.reqs, recorded{Method: req.Method, Path: req.URL.Path, Headers: h, Body: body})
		r.raw = append(r.raw, body)
		r.hdrs = append(r.hdrs, req.Header.Clone())
		status := r.status
		r.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(r.Close)
	return r
}

func (r *recorder) requests() []recorded {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recorded(nil), r.reqs...)
}

// checkGolden compares v, as indented JSON, to testdata/notify/file.
func checkGolden(t *testing.T, file string, v any) {
	t.Helper()
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join("testdata", "notify", file)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./internal/alerts -run Contract -update)", err)
	}
	if !bytes.Equal(b.Bytes(), want) {
		t.Errorf("%s differs from the recorded payload (run with -update and review the diff):\n%s", path, b.String())
	}
}

// fakeStore is an in-memory NotifyStore.
type fakeStore struct {
	mu       sync.Mutex
	events   map[uuid.UUID]db.GetAlertEventNotificationRow
	uptime   map[uuid.UUID]db.GetUptimeEventNotificationRow
	health   map[uuid.UUID]db.GetHealthCheckEventNotificationRow
	channels map[uuid.UUID]db.NotificationChannel
	notified map[uuid.UUID]time.Time
	err      error
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		events: map[uuid.UUID]db.GetAlertEventNotificationRow{}, uptime: map[uuid.UUID]db.GetUptimeEventNotificationRow{},
		health:   map[uuid.UUID]db.GetHealthCheckEventNotificationRow{},
		channels: map[uuid.UUID]db.NotificationChannel{},
		notified: map[uuid.UUID]time.Time{},
	}
}

func (s *fakeStore) GetAlertEventNotification(_ context.Context, id uuid.UUID) (db.GetAlertEventNotificationRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return db.GetAlertEventNotificationRow{}, s.err
	}
	r, ok := s.events[id]
	if !ok {
		return r, pgx.ErrNoRows
	}
	return r, nil
}

func (s *fakeStore) GetUptimeEventNotification(_ context.Context, id uuid.UUID) (db.GetUptimeEventNotificationRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return db.GetUptimeEventNotificationRow{}, s.err
	}
	r, ok := s.uptime[id]
	if !ok {
		return r, pgx.ErrNoRows
	}
	return r, nil
}

func (s *fakeStore) GetHealthCheckEventNotification(_ context.Context, id uuid.UUID) (db.GetHealthCheckEventNotificationRow, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return db.GetHealthCheckEventNotificationRow{}, s.err
	}
	r, ok := s.health[id]
	if !ok {
		return r, pgx.ErrNoRows
	}
	return r, nil
}

func (s *fakeStore) ListNotificationChannelsByIDs(_ context.Context, arg db.ListNotificationChannelsByIDsParams) ([]db.NotificationChannel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []db.NotificationChannel
	for _, id := range arg.Ids {
		if c, ok := s.channels[id]; ok && c.ProjectID == arg.ProjectID {
			out = append(out, c)
		}
	}
	return out, nil
}

func (s *fakeStore) GetNotificationChannel(_ context.Context, arg db.GetNotificationChannelParams) (db.NotificationChannel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.channels[arg.ID]
	if !ok || c.ProjectID != arg.ProjectID {
		return c, pgx.ErrNoRows
	}
	return c, nil
}

func (s *fakeStore) MarkAlertEventNotified(_ context.Context, arg db.MarkAlertEventNotifiedParams) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.notified[arg.ID]; ok {
		return 0, nil
	}
	s.notified[arg.ID] = arg.NotifiedAt
	return 1, nil
}

// fakeJobs records inserted job args.
type fakeJobs struct {
	mu   sync.Mutex
	args []river.JobArgs
}

func (j *fakeJobs) InsertTx(_ context.Context, _ pgx.Tx, args river.JobArgs, _ *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.args = append(j.args, args)
	return &rivertype.JobInsertResult{Job: &rivertype.JobRow{}}, nil
}

func (j *fakeJobs) inserted() []river.JobArgs {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]river.JobArgs(nil), j.args...)
}

// harness wires a Notifier over fakes.
type harness struct {
	store  *fakeStore
	jobs   *fakeJobs
	sealer *idkeys.Sealer
	logs   *bytes.Buffer
	n      *Notifier
}

func newHarness(t *testing.T, client *http.Client) *harness {
	t.Helper()
	h := &harness{store: newFakeStore(), jobs: &fakeJobs{}, sealer: testSealer(t), logs: &bytes.Buffer{}}
	logger := slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	h.n = newNotifier(h.store, h.jobs, func(_ context.Context, fn func(pgx.Tx, NotifyStore) error) error {
		return fn(nil, h.store)
	}, NotifierOptions{
		PublicUIURL: testUIURL, Sealer: h.sealer,
		Poster: NewPoster(PosterOptions{Client: client, Now: func() time.Time { return testNow }}),
		Now:    func() time.Time { return testNow },
	}, logger)
	return h
}

// addChannel stores a channel with config sealed as the API would.
func (h *harness) addChannel(t *testing.T, typ ChannelType, config string) uuid.UUID {
	t.Helper()
	id := uuid.NewSHA1(uuid.NameSpaceURL, []byte("channel/"+string(typ)))
	sealed, err := SealChannelConfig(h.sealer, id, json.RawMessage(config))
	if err != nil {
		t.Fatal(err)
	}
	h.store.channels[id] = db.NotificationChannel{ID: id, ProjectID: testProjectID, Type: string(typ), Name: string(typ), ConfigEnc: sealed}
	return id
}

// work runs one alerts.deliver job through its worker, as River would.
func (h *harness) work(args DeliverArgs, attempt int) error {
	return NewDeliverWorker(h.n).Work(context.Background(), &river.Job[DeliverArgs]{
		JobRow: &rivertype.JobRow{ID: 42, Attempt: attempt, MaxAttempts: 1 + NotifyMaxRetries}, Args: args,
	})
}

// TestChannelContracts posts each kind of notification to each HTTP channel
// and compares the requests to the recorded payloads in testdata/notify.
func TestChannelContracts(t *testing.T) {
	for _, typ := range []ChannelType{ChannelSlack, ChannelTeams, ChannelWebhook} {
		for _, kind := range []NotificationKind{NotifyTriggered, NotifyResolved} {
			t.Run(string(typ)+"_"+string(kind), func(t *testing.T) {
				srv := newRecorder(t)
				h := newHarness(t, srv.Client())
				const secret = "whsec_0123456789abcdef"
				var config string
				switch typ {
				case ChannelWebhook:
					config = `{"url":"` + srv.URL + `/hooks/apilens","secret":"` + secret + `"}`
				default:
					config = `{"webhook_url":"` + srv.URL + `/services/T000/B000/XXXX"}`
				}
				ch := h.addChannel(t, typ, config)
				h.store.events[testEventID] = eventRow(kind, ch)
				if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: kind}, 1); err != nil {
					t.Fatal(err)
				}
				reqs := srv.requests()
				if len(reqs) != 1 {
					t.Fatalf("requests = %d, want 1", len(reqs))
				}
				if typ == ChannelWebhook {
					hdr := srv.hdrs[0]
					if err := VerifyWebhookSignature(secret, hdr.Get(HeaderWebhookTimestamp), hdr.Get(HeaderWebhookSignature), srv.raw[0], testNow, 5*time.Minute); err != nil {
						t.Errorf("signature: %v", err)
					}
					if err := VerifyWebhookSignature("whsec_another_secret_", hdr.Get(HeaderWebhookTimestamp), hdr.Get(HeaderWebhookSignature), srv.raw[0], testNow, 5*time.Minute); err == nil {
						t.Error("signature verified with the wrong secret")
					}
					if err := VerifyWebhookSignature(secret, hdr.Get(HeaderWebhookTimestamp), hdr.Get(HeaderWebhookSignature), srv.raw[0], testNow.Add(time.Hour), 5*time.Minute); err == nil {
						t.Error("stale timestamp verified")
					}
				}
				checkGolden(t, string(typ)+"_"+string(kind)+".json", reqs[0])
				_, marked := h.store.notified[testEventID]
				if marked != (kind == NotifyTriggered) {
					t.Errorf("notified_at set = %v for %s", marked, kind)
				}
			})
		}
	}
}

// TestEmailContract delivers to an email channel: one email.send job per
// address, with data the built-in template renders.
func TestEmailContract(t *testing.T) {
	renderer, err := email.DefaultRenderer(email.WithPublicUIURL(testUIURL))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []NotificationKind{NotifyTriggered, NotifyResolved} {
		t.Run(string(kind), func(t *testing.T) {
			h := newHarness(t, nil)
			ch := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com","ops@example.com"]}`)
			h.store.events[testEventID] = eventRow(kind, ch)
			if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: kind}, 1); err != nil {
				t.Fatal(err)
			}
			jobs := h.jobs.inserted()
			if len(jobs) != 2 {
				t.Fatalf("jobs = %d, want 2", len(jobs))
			}
			for _, j := range jobs {
				a, ok := j.(email.SendArgs)
				if !ok {
					t.Fatalf("job %T, want email.SendArgs", j)
				}
				// Round-trip through JSON, as River stores it.
				b, _ := json.Marshal(a)
				var stored email.SendArgs
				if err := json.Unmarshal(b, &stored); err != nil {
					t.Fatal(err)
				}
				msg, err := renderer.Render(stored.Template, stored.To, stored.Data)
				if err != nil {
					t.Fatalf("render %s: %v", stored.Template, err)
				}
				if !strings.Contains(msg.Text, "https://app.example.com/shop/incidents?event="+testEventID.String()) {
					t.Errorf("no incident link in:\n%s", msg.Text)
				}
			}
			checkGolden(t, "email_"+string(kind)+".json", jobs)
		})
	}
}

// TestDeliverSecretsNeverLogged fails deliveries every way and checks that
// neither logs, errors nor job args carry a channel's URL, secret or
// addresses.
func TestDeliverSecretsNeverLogged(t *testing.T) {
	const (
		token  = "T0SECRET/B0SECRET/xoxSECRETtoken"
		secret = "whsec_SECRETsigningkey"
	)
	secrets := []string{token, secret, "SECRET"}
	check := func(t *testing.T, h *harness, err error) {
		t.Helper()
		for _, s := range secrets {
			if err != nil && strings.Contains(err.Error(), s) {
				t.Errorf("error carries a secret: %v", err)
			}
			if strings.Contains(h.logs.String(), s) {
				t.Errorf("logs carry a secret:\n%s", h.logs.String())
			}
		}
	}

	t.Run("server errors are retried", func(t *testing.T) {
		srv := newRecorder(t)
		srv.status = http.StatusInternalServerError
		h := newHarness(t, srv.Client())
		ch := h.addChannel(t, ChannelSlack, `{"webhook_url":"`+srv.URL+`/services/`+token+`"}`)
		h.store.events[testEventID] = eventRow(NotifyTriggered, ch)
		err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}, 1)
		var de *DeliveryError
		var cancel *river.JobCancelError
		if !errors.As(err, &de) || de.Status != 500 || errors.As(err, &cancel) {
			t.Fatalf("err = %v, want a retryable HTTP 500", err)
		}
		if _, ok := h.store.notified[testEventID]; ok {
			t.Error("notified_at set after a failed delivery")
		}
		check(t, h, err)
	})

	t.Run("client errors are dropped", func(t *testing.T) {
		srv := newRecorder(t)
		srv.status = http.StatusNotFound
		h := newHarness(t, srv.Client())
		ch := h.addChannel(t, ChannelWebhook, `{"url":"`+srv.URL+`/`+token+`","secret":"`+secret+`"}`)
		h.store.events[testEventID] = eventRow(NotifyTriggered, ch)
		err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}, 1)
		var cancel *river.JobCancelError
		if !errors.As(err, &cancel) {
			t.Fatalf("err = %v, want JobCancel", err)
		}
		check(t, h, err)
	})

	t.Run("connection failures", func(t *testing.T) {
		srv := newRecorder(t)
		url := srv.URL
		srv.Close()
		h := newHarness(t, srv.Client())
		ch := h.addChannel(t, ChannelTeams, `{"webhook_url":"`+url+`/webhookb2/`+token+`"}`)
		h.store.events[testEventID] = eventRow(NotifyResolved, ch)
		err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyResolved}, 1+NotifyMaxRetries)
		if err == nil {
			t.Fatal("delivered to a closed server")
		}
		check(t, h, err)
	})

	t.Run("non-public addresses are refused", func(t *testing.T) {
		srv := newRecorder(t)
		h := newHarness(t, nil) // the guarded default client
		ch := h.addChannel(t, ChannelSlack, `{"webhook_url":"`+srv.URL+`/services/`+token+`"}`)
		h.store.events[testEventID] = eventRow(NotifyTriggered, ch)
		err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}, 1)
		var cancel *river.JobCancelError
		if !errors.As(err, &cancel) || !strings.Contains(err.Error(), "not a public address") {
			t.Fatalf("err = %v, want a dropped delivery to a blocked address", err)
		}
		if n := len(srv.requests()); n != 0 {
			t.Errorf("requests = %d, want 0", n)
		}
		check(t, h, err)
	})

	t.Run("email addresses", func(t *testing.T) {
		h := newHarness(t, nil)
		ch := h.addChannel(t, ChannelEmail, `{"addresses":["SECRET@example.com"]}`)
		h.store.events[testEventID] = eventRow(NotifyTriggered, ch)
		if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}, 1); err != nil {
			t.Fatal(err)
		}
		check(t, h, nil)
	})

	t.Run("unreadable config", func(t *testing.T) {
		h := newHarness(t, nil)
		ch := h.addChannel(t, ChannelSlack, `{"webhook_url":"`+"https://hooks.slack.com/services/"+token+`"}`)
		c := h.store.channels[ch]
		c.ConfigEnc[len(c.ConfigEnc)-1] ^= 1 // tampered
		h.store.events[testEventID] = eventRow(NotifyTriggered, ch)
		err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}, 1)
		var cancel *river.JobCancelError
		if !errors.As(err, &cancel) || !errors.Is(err, idkeys.ErrDecrypt) {
			t.Fatalf("err = %v, want a dropped ErrDecrypt", err)
		}
		check(t, h, err)
	})

	t.Run("job args carry ids only", func(t *testing.T) {
		b, err := json.Marshal(DeliverArgs{EventID: testEventID, ChannelID: testRuleID, Notification: NotifyTriggered})
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if len(m) != 3 {
			t.Errorf("args = %s", b)
		}
	})
}

func TestDeliverSkipsWhatIsGone(t *testing.T) {
	h := newHarness(t, nil)
	ch := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com"]}`)
	other := uuid.New()
	// Event deleted with its rule.
	if sent, err := h.n.Deliver(context.Background(), DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}); sent || err != nil {
		t.Errorf("deleted event: %v %v", sent, err)
	}
	// Channel removed from the rule, or deleted.
	h.store.events[testEventID] = eventRow(NotifyTriggered, other)
	if sent, err := h.n.Deliver(context.Background(), DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: NotifyTriggered}); sent || err != nil {
		t.Errorf("removed channel: %v %v", sent, err)
	}
	if sent, err := h.n.Deliver(context.Background(), DeliverArgs{EventID: testEventID, ChannelID: other, Notification: NotifyTriggered}); sent || err != nil {
		t.Errorf("deleted channel: %v %v", sent, err)
	}
	if n := len(h.jobs.inserted()); n != 0 {
		t.Errorf("jobs = %d, want 0", n)
	}
}

func TestFanOut(t *testing.T) {
	h := newHarness(t, nil)
	email := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com"]}`)
	slack := h.addChannel(t, ChannelSlack, `{"webhook_url":"https://hooks.slack.com/services/T/B/X"}`)
	deleted := uuid.New()
	h.store.events[testEventID] = eventRow(NotifyResolved, email, slack, deleted)
	n, err := h.n.FanOut(context.Background(), NotifyArgs{EventID: testEventID, Notification: NotifyResolved})
	if err != nil || n != 2 {
		t.Fatalf("FanOut = %d, %v; want 2", n, err)
	}
	got := map[uuid.UUID]bool{}
	for _, j := range h.jobs.inserted() {
		a := j.(DeliverArgs)
		if a.EventID != testEventID || a.Notification != NotifyResolved {
			t.Errorf("args = %+v", a)
		}
		got[a.ChannelID] = true
	}
	if !got[email] || !got[slack] {
		t.Errorf("delivered to %v", got)
	}
	if n, err := h.n.FanOut(context.Background(), NotifyArgs{EventID: uuid.New(), Notification: NotifyTriggered}); n != 0 || err != nil {
		t.Errorf("deleted event: %d, %v", n, err)
	}
	var cancel *river.JobCancelError
	if _, err := h.n.FanOut(context.Background(), NotifyArgs{EventID: testEventID, Notification: "paged"}); !errors.As(err, &cancel) {
		t.Errorf("unknown kind: %v", err)
	}
}

func TestJobUniqueness(t *testing.T) {
	for _, opts := range []river.InsertOpts{NotifyArgs{}.InsertOpts(), DeliverArgs{}.InsertOpts()} {
		if !opts.UniqueOpts.ByArgs || opts.MaxAttempts != 1+NotifyMaxRetries {
			t.Errorf("opts = %+v", opts)
		}
	}
	a := DeliverArgs{EventID: testEventID, ChannelID: testRuleID, Notification: NotifyTriggered}
	b := a
	b.Notification = NotifyResolved
	again := a
	if a.DeliveryID() != again.DeliveryID() || a.DeliveryID() == b.DeliveryID() {
		t.Error("delivery ids must be stable per event, channel and kind")
	}
}
