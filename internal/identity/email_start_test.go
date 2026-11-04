package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeEmailTokens is an in-memory EmailTokens.
type fakeEmailTokens struct {
	mu        sync.Mutex
	now       func() time.Time
	rows      []db.AuthEmailToken
	issued    []emailauth.IssueOptions
	issueErr  error
	latestErr error
}

func (f *fakeEmailTokens) Issue(_ context.Context, addr string, intent emailauth.Intent, opts emailauth.IssueOptions) (emailauth.Issued, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.issueErr != nil {
		return emailauth.Issued{}, f.issueErr
	}
	row := db.AuthEmailToken{ID: uuid.New(), Email: addr, Intent: string(intent), UserID: opts.UserID, NextPath: opts.NextPath, CreatedAt: f.now(), ExpiresAt: f.now().Add(emailauth.TTL)}
	f.rows = append(f.rows, row)
	f.issued = append(f.issued, opts)
	return emailauth.Issued{LinkToken: "link-" + row.ID.String(), Code: "123456", Row: row}, nil
}

func (f *fakeEmailTokens) Latest(_ context.Context, addr string) (db.AuthEmailToken, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.latestErr != nil {
		return db.AuthEmailToken{}, false, f.latestErr
	}
	for i := len(f.rows) - 1; i >= 0; i-- {
		if f.rows[i].Email == addr {
			return f.rows[i], true, nil
		}
	}
	return db.AuthEmailToken{}, false, nil
}

// fakeUsers knows the users in byEmail (lower-case keys).
type fakeUsers struct {
	byEmail map[string]db.User
	err     error
}

func (f *fakeUsers) GetUserByEmail(_ context.Context, addr string) (db.User, error) {
	if f.err != nil {
		return db.User{}, f.err
	}
	u, ok := f.byEmail[strings.ToLower(addr)]
	if !ok {
		return db.User{}, pgx.ErrNoRows
	}
	return u, nil
}

// fakeJobs records enqueued email jobs.
type fakeJobs struct {
	jobs []email.SendArgs
	err  error
}

func (f *fakeJobs) Insert(_ context.Context, args river.JobArgs, _ *river.InsertOpts) (*rivertype.JobInsertResult, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.jobs = append(f.jobs, args.(email.SendArgs))
	return &rivertype.JobInsertResult{}, nil
}

// fakeAudit records audit events.
type fakeAudit struct {
	events []audit.Event
	err    error
}

func (f *fakeAudit) Record(_ context.Context, e audit.Event) error {
	f.events = append(f.events, e)
	return f.err
}

type emailStartHarness struct {
	api    humatest.TestAPI
	tokens *fakeEmailTokens
	users  *fakeUsers
	jobs   *fakeJobs
	audit  *fakeAudit
	clock  *time.Time
	logs   *bytes.Buffer
}

var knownUser = db.User{ID: uuid.New(), Email: "ada@example.com"}

func newEmailStartHarness(t *testing.T) *emailStartHarness {
	t.Helper()
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	limiter, err := ratelimit.New(nil, logger, nil) // zero rates: limits disabled
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	h := &emailStartHarness{
		users: &fakeUsers{byEmail: map[string]db.User{"ada@example.com": knownUser}},
		jobs:  &fakeJobs{},
		audit: &fakeAudit{},
		clock: &now,
		logs:  logs,
	}
	h.tokens = &fakeEmailTokens{now: func() time.Time { return *h.clock }}
	e := NewEmailStart(config.IdentityConfig{}, EmailStartDeps{Tokens: h.tokens, Users: h.users, Jobs: h.jobs, Audit: h.audit}, limiter, logger)
	e.now = func() time.Time { return *h.clock }
	_, h.api = humatest.New(t)
	e.Register(h.api)
	return h
}

func (h *emailStartHarness) start(t *testing.T, body map[string]any) (int, map[string]any) {
	t.Helper()
	resp := h.api.Post(AuthPrefix+"/email/start", body)
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	return resp.Code, out
}

func TestEmailStartSameAnswerForKnownAndUnknown(t *testing.T) {
	h := newEmailStartHarness(t)
	var bodies []string
	for _, addr := range []string{"Ada@Example.com", "nobody@example.com"} {
		resp := h.api.Post(AuthPrefix+"/email/start", map[string]any{"email": addr, "intent": "signin"})
		if resp.Code != http.StatusOK {
			t.Fatalf("%s: status = %d: %s", addr, resp.Code, resp.Body)
		}
		bodies = append(bodies, resp.Body.String())
	}
	if bodies[0] != bodies[1] {
		t.Fatalf("known %s != unknown %s", bodies[0], bodies[1])
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(bodies[0]), &body)
	if body["sent"] != true || body["retry_after"] != float64(30) {
		t.Fatalf("body = %v, want {sent: true, retry_after: 30}", body)
	}

	if len(h.jobs.jobs) != 2 {
		t.Fatalf("jobs = %d, want 2", len(h.jobs.jobs))
	}
	known, unknown := h.jobs.jobs[0], h.jobs.jobs[1]
	if known.To != "ada@example.com" || known.Template != email.TemplateAuthCode ||
		known.Data["code"] != "123456" || known.Data["email"] != "ada@example.com" ||
		!strings.HasPrefix(known.Data["token"].(string), "link-") || known.Data["expires_in"] != "15 minutes" {
		t.Errorf("known job = %+v", known)
	}
	if unknown.To != "nobody@example.com" || unknown.Template != email.TemplateAuthNoAccount ||
		unknown.Data["email"] != "nobody@example.com" || unknown.Data["code"] != nil {
		t.Errorf("unknown job = %+v", unknown)
	}
	// A row is issued either way; only the known one carries the user.
	if len(h.tokens.rows) != 2 || h.tokens.rows[0].UserID == nil || *h.tokens.rows[0].UserID != knownUser.ID || h.tokens.rows[1].UserID != nil {
		t.Errorf("rows = %+v", h.tokens.rows)
	}

	if len(h.audit.events) != 2 {
		t.Fatalf("audit events = %d, want 2", len(h.audit.events))
	}
	for i, ev := range h.audit.events {
		if ev.Kind != audit.LoginRequested || ev.Meta["intent"] != "signin" || ev.Meta["email_sent"] != true {
			t.Errorf("event %d = %+v", i, ev)
		}
	}
	if h.audit.events[0].User == nil || *h.audit.events[0].User != knownUser.ID || h.audit.events[1].User != nil {
		t.Errorf("event users = %v, %v", h.audit.events[0].User, h.audit.events[1].User)
	}
}

func TestEmailStartSignUpSendsCode(t *testing.T) {
	h := newEmailStartHarness(t)
	for _, addr := range []string{"new@example.com", "ada@example.com"} {
		if code, body := h.start(t, map[string]any{"email": addr, "intent": "signup", "next": "/projects/x"}); code != http.StatusOK || body["sent"] != true {
			t.Fatalf("%s: %d %v", addr, code, body)
		}
	}
	for i, j := range h.jobs.jobs {
		if j.Template != email.TemplateAuthCode {
			t.Errorf("job %d template = %s, want auth_code", i, j.Template)
		}
	}
	for i, o := range h.tokens.issued {
		if o.NextPath == nil || *o.NextPath != "/projects/x" {
			t.Errorf("issue %d next = %v", i, o.NextPath)
		}
	}
	if ev := h.audit.events[0]; ev.Meta["intent"] != "signup" || ev.User != nil {
		t.Errorf("event = %+v", ev)
	}
}

func TestEmailStartCooldown(t *testing.T) {
	h := newEmailStartHarness(t)
	req := map[string]any{"email": "ada@example.com", "intent": "signin"}
	if code, _ := h.start(t, req); code != http.StatusOK {
		t.Fatal(code)
	}

	*h.clock = h.clock.Add(12 * time.Second)
	code, body := h.start(t, req)
	if code != http.StatusOK || body["sent"] != true || body["retry_after"] != float64(18) {
		t.Fatalf("inside cooldown: %d %v, want 200 retry_after 18", code, body)
	}
	if len(h.jobs.jobs) != 1 || len(h.tokens.rows) != 1 {
		t.Fatalf("inside cooldown: jobs %d, rows %d; want no new email", len(h.jobs.jobs), len(h.tokens.rows))
	}
	if ev := h.audit.events[len(h.audit.events)-1]; ev.Kind != audit.LoginRequested || ev.Meta["email_sent"] != false || ev.Meta["intent"] != "signin" {
		t.Errorf("cooldown event = %+v", ev)
	}

	// A different intent is not held back (sign-up right after "no account").
	if code, _ := h.start(t, map[string]any{"email": "ada@example.com", "intent": "signup"}); code != http.StatusOK || len(h.jobs.jobs) != 2 {
		t.Fatalf("other intent: %d, jobs %d", code, len(h.jobs.jobs))
	}

	*h.clock = h.clock.Add(EmailResendCooldown)
	code, body = h.start(t, req)
	if code != http.StatusOK || body["retry_after"] != float64(30) || len(h.jobs.jobs) != 3 {
		t.Fatalf("after cooldown: %d %v, jobs %d", code, body, len(h.jobs.jobs))
	}
}

func TestEmailStartInvalid(t *testing.T) {
	h := newEmailStartHarness(t)
	for _, body := range []map[string]any{
		{"email": "ada@localhost", "intent": "signin"},
		{"email": "ada@example.com", "intent": "signin", "next": "//evil.example"},
		{"email": "ada@example.com", "intent": "signin", "next": "https://evil.example"},
	} {
		code, out := h.start(t, body)
		if code != http.StatusBadRequest || out["code"] != string(CodeInvalidRequest) {
			t.Errorf("%v: %d %v, want 400 invalid_request", body, code, out)
		}
	}
	for _, body := range []map[string]any{
		{"email": "not-an-email", "intent": "signin"},
		{"email": "Ada <ada@example.com>", "intent": "signin"},
		{"email": "ada@example.com", "intent": "verify_email"},
		{"email": "ada@example.com"},
	} {
		if code, _ := h.start(t, body); code != http.StatusUnprocessableEntity {
			t.Errorf("%v: %d, want 422", body, code)
		}
	}
	if len(h.jobs.jobs) != 0 || len(h.audit.events) != 0 {
		t.Fatalf("invalid requests sent %d emails, %d events", len(h.jobs.jobs), len(h.audit.events))
	}
}

func TestEmailStartFailures(t *testing.T) {
	boom := errors.New("boom")
	for name, setup := range map[string]func(*emailStartHarness){
		"users":   func(h *emailStartHarness) { h.users.err = boom },
		"latest":  func(h *emailStartHarness) { h.tokens.latestErr = boom },
		"issue":   func(h *emailStartHarness) { h.tokens.issueErr = boom },
		"enqueue": func(h *emailStartHarness) { h.jobs.err = boom },
	} {
		t.Run(name, func(t *testing.T) {
			h := newEmailStartHarness(t)
			setup(h)
			code, out := h.start(t, map[string]any{"email": "ada@example.com", "intent": "signin"})
			if code != http.StatusInternalServerError || out["code"] != string(CodeInternal) {
				t.Fatalf("%d %v, want 500 internal_error", code, out)
			}
			if strings.Contains(h.logs.String(), "123456") {
				t.Fatal("code logged")
			}
		})
	}

	// An audit failure is logged; the email still goes out.
	h := newEmailStartHarness(t)
	h.audit.err = boom
	if code, _ := h.start(t, map[string]any{"email": "ada@example.com", "intent": "signin"}); code != http.StatusOK || len(h.jobs.jobs) != 1 {
		t.Fatalf("audit failure: %d, jobs %d", code, len(h.jobs.jobs))
	}
	if !strings.Contains(h.logs.String(), "email start: audit") {
		t.Error("audit failure not logged")
	}
}

func TestEmailStartRateLimiterUnavailable(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, _ := ratelimit.New(nil, logger, nil) // no Valkey: fails closed
	cfg := config.IdentityConfig{}
	cfg.RateLimits.EmailStartPerEmail = config.RateLimit{Limit: 5, Window: time.Minute}
	jobs := &fakeJobs{}
	e := NewEmailStart(cfg, EmailStartDeps{
		Tokens: &fakeEmailTokens{now: time.Now}, Users: &fakeUsers{}, Jobs: jobs, Audit: &fakeAudit{},
	}, limiter, logger)
	_, api := humatest.New(t)
	e.Register(api)
	resp := api.Post(AuthPrefix+"/email/start", map[string]any{"email": "ada@example.com", "intent": "signin"})
	if resp.Code != http.StatusServiceUnavailable || len(jobs.jobs) != 0 {
		t.Fatalf("status = %d, jobs %d; want 503 and no email", resp.Code, len(jobs.jobs))
	}
}

func TestNormalizeEmail(t *testing.T) {
	for in, want := range map[string]string{
		" Ada.Lovelace+x@Example.COM ": "ada.lovelace+x@example.com",
		"a@b.co":                       "a@b.co",
	} {
		if got, ok := NormalizeEmail(in); !ok || got != want {
			t.Errorf("NormalizeEmail(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{
		"", "ada", "@example.com", "ada@", "ada@example", "ada@.example.com", "ada@example.com.",
		"Ada <ada@example.com>", `"a b"@example.com`, "ada@example.com (comment)", "a@b@c.com",
		strings.Repeat("a", 250) + "@x.com", "ada@exa\nmple.com",
	} {
		if got, ok := NormalizeEmail(bad); ok {
			t.Errorf("NormalizeEmail(%q) = %q, accepted", bad, got)
		}
	}
}
