//go:build integration

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEmailStartIntegration runs POST /auth/email/start against Postgres
// (users, auth_email_tokens, audit_events, River jobs) and Valkey (limits).
func TestEmailStartIntegration(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	reg := jobs.NewRegistry()
	jobs.Register(reg, river.WorkFunc(func(context.Context, *river.Job[email.SendArgs]) error { return nil }))
	jc, err := jobs.New(pool, config.JobsConfig{}, reg, time.Second, logger, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}

	known, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "known@example.com"})
	if err != nil {
		t.Fatal(err)
	}

	cfg := config.IdentityConfig{}
	cfg.RateLimits.EmailStartPerEmail = config.RateLimit{Limit: 3, Window: time.Minute}
	cfg.RateLimits.EmailStartPerIP = config.RateLimit{Limit: 100, Window: time.Minute}
	e := NewEmailStart(cfg, EmailStartDeps{
		Tokens: emailauth.New(emailauth.NewStore(pool), emailauth.Options{}),
		Users:  q,
		Jobs:   jc,
		Audit:  audit.New(pool),
	}, limiter, logger)
	_, api := humatest.New(t)
	e.Register(api)
	start := func(addr, intent string) *httptest.ResponseRecorder {
		t.Helper()
		return api.Post(AuthPrefix+"/email/start", map[string]any{"email": addr, "intent": intent})
	}
	read := func(r *httptest.ResponseRecorder) string {
		t.Helper()
		var b json.RawMessage
		if err := json.Unmarshal(r.Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	emailJobs := func() []email.SendArgs {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT args FROM river_job WHERE kind = 'email.send' ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []email.SendArgs
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				t.Fatal(err)
			}
			var a email.SendArgs
			if err := json.Unmarshal(raw, &a); err != nil {
				t.Fatal(err)
			}
			out = append(out, a)
		}
		return out
	}

	t.Run("same response body for known and unknown emails", func(t *testing.T) {
		rk, ru := start("Known@Example.com", "signin"), start("unknown@example.com", "signin")
		if rk.Code != http.StatusOK || ru.Code != http.StatusOK {
			t.Fatalf("status = %d, %d", rk.Code, ru.Code)
		}
		if bk, bu := read(rk), read(ru); bk != bu || bk != `{"sent":true,"retry_after":30}` {
			t.Fatalf("known %s, unknown %s", bk, bu)
		}
		js := emailJobs()
		if len(js) != 2 || js[0].To != "known@example.com" || js[0].Template != email.TemplateAuthCode ||
			js[1].To != "unknown@example.com" || js[1].Template != email.TemplateAuthNoAccount {
			t.Fatalf("jobs = %+v", js)
		}
		// The emailed code verifies against the stored row.
		if _, err := emailauth.New(emailauth.NewStore(pool), emailauth.Options{}).VerifyCode(ctx, "known@example.com", js[0].Data["code"].(string)); err != nil {
			t.Fatalf("verify emailed code: %v", err)
		}
	})

	t.Run("cooldown and audit", func(t *testing.T) {
		before := len(emailJobs())
		r := start("cool@example.com", "signup")
		if r.Code != http.StatusOK {
			t.Fatal(r.Code)
		}
		r = start("cool@example.com", "signup")
		var body EmailStartResponse
		_ = json.Unmarshal([]byte(read(r)), &body)
		if r.Code != http.StatusOK || !body.Sent || body.RetryAfter < 1 || body.RetryAfter > 30 {
			t.Fatalf("inside cooldown: %d %+v", r.Code, body)
		}
		if n := len(emailJobs()) - before; n != 1 {
			t.Fatalf("emails sent = %d, want 1", n)
		}

		evs, err := q.ListAuditEventsForUser(ctx, db.ListAuditEventsForUserParams{UserID: known.ID, PageSize: 10})
		if err != nil {
			t.Fatal(err)
		}
		if len(evs) != 1 || evs[0].Event != string(audit.LoginRequested) {
			t.Fatalf("known user's events = %+v", evs)
		}
		var meta map[string]any
		if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil || meta["intent"] != "signin" || meta["email_sent"] != true {
			t.Fatalf("meta = %s (%v)", evs[0].Metadata, err)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE event = 'login.requested' AND user_id IS NULL AND metadata->>'intent' = 'signup'`).Scan(&n); err != nil || n != 2 {
			t.Fatalf("anonymous signup events = %d (%v), want 2", n, err)
		}
	})

	t.Run("rate limited per email", func(t *testing.T) {
		for i := range 3 {
			if r := start("limited@example.com", "signin"); r.Code != http.StatusOK {
				t.Fatalf("request %d: %d", i+1, r.Code)
			}
		}
		r := start("LIMITED@example.com", "signin")
		if r.Code != http.StatusTooManyRequests {
			t.Fatalf("4th request: %d, want 429", r.Code)
		}
		ra, err := strconv.Atoi(r.Header().Get("Retry-After"))
		if err != nil || ra < 1 {
			t.Fatalf("Retry-After = %q", r.Header().Get("Retry-After"))
		}
		var p Problem
		if err := json.Unmarshal(r.Body.Bytes(), &p); err != nil || p.Code != CodeRateLimited || p.RetryAfter != ra {
			t.Fatalf("problem = %+v (%v)", p, err)
		}
	})
}
