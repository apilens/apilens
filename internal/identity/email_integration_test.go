//go:build integration

package identity

import (
	"bufio"
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	signingkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEmailSignInEndToEnd walks the email sign-in flow over real HTTP, wired
// as the identity role wires it: POST /auth/email/start enqueues an
// email.send job, the River worker renders it and hands it to the log email
// provider (captured in a buffer), the code read from that log signs in at
// POST /auth/email/verify, the access token reads GET /users/me, the refresh
// token rotates at POST /auth/refresh, replaying the rotated one revokes the
// family, and POST /auth/logout ends a second sign-in. Postgres holds users,
// codes, sessions, audit rows and jobs; Valkey the limits and the denylist.
func TestEmailSignInEndToEnd(t *testing.T) {
	const (
		issuerURL = "https://id.example.com"
		accessTTL = 15 * time.Minute
		userAgent = "apilens-e2e-test"
		addr      = "e2e-signin@example.com"
	)
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	logger := testutil.Logger(t)

	// The log email provider writes every message here, as JSON lines.
	mail := &syncBuffer{}
	sender := email.NewLogSender(slog.New(slog.NewJSONHandler(io.MultiWriter(mail, testLogWriter{t}), nil)))
	renderer, err := email.DefaultRenderer(email.WithPublicUIURL("http://localhost:3000"))
	if err != nil {
		t.Fatal(err)
	}
	reg := jobs.NewRegistry()
	jobs.Register(reg, email.NewWorker(renderer, sender, logger, email.NewMetrics(nil)))
	jc, err := jobs.New(pool, config.JobsConfig{Enabled: true, MaxWorkers: 2, MetricsInterval: time.Minute}, reg, 5*time.Second, logger, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	runCtx, stopJobs := context.WithCancel(ctx)
	jobsDone := make(chan error, 1)
	go func() { jobsDone <- jc.Run(runCtx) }()
	t.Cleanup(func() {
		stopJobs()
		if err := <-jobsDone; err != nil {
			t.Errorf("jobs: %v", err)
		}
	})

	priv, err := rsa.GenerateKey(rand.Reader, signingkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	keyNow := time.Now()
	k, err := signingkeys.Unstored(priv, &keyNow, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(itestKeys{k}, token.Options{Issuer: issuerURL, TTL: accessTTL})
	if err != nil {
		t.Fatal(err)
	}
	src := authn.KeySourceFunc(func(_ context.Context, kid string) (crypto.PublicKey, error) {
		if kid != k.KID {
			return nil, authn.ErrUnknownKey
		}
		return k.Signer().Public(), nil
	})
	deny := authn.NewDenylist(vk, accessTTL, logger)
	sessions, err := session.New(pool, issuer, session.Options{
		RefreshTTL:      720 * time.Hour,
		RefreshTTLShort: 24 * time.Hour,
		Jobs:            jc,
		AccessTTL:       accessTTL,
		Denylist:        deny,
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	cfg := config.IdentityConfig{Issuer: issuerURL, PreAuthTTL: 5 * time.Minute, PublicUIURL: "http://localhost:3000"}
	cfg.RateLimits.EmailStartPerEmail = config.RateLimit{Limit: 10, Window: time.Minute}
	cfg.RateLimits.EmailStartPerIP = config.RateLimit{Limit: 100, Window: time.Minute}
	cfg.RateLimits.CodeVerifyPerEmail = config.RateLimit{Limit: 100, Window: time.Minute}
	cfg.RateLimits.RefreshPerIP = config.RateLimit{Limit: 100, Window: time.Minute}

	// The identity role's wiring (internal/app initIdentity), trimmed to the
	// endpoints of this flow.
	srv := server.New(config.ServerConfig{}, logger, prometheus.NewRegistry())
	srv.Use(Middleware(cfg))
	srv.Use(audit.Middleware)
	api := srv.API()
	api.UseMiddleware(authn.Middleware(api, authn.NewSessionVerifier(src, issuerURL, nil).WithDenylist(deny)))
	NewSessions(cfg, sessions, limiter, logger).Register(api)
	NewEmailStart(cfg, EmailStartDeps{
		Tokens: emailauth.New(emailauth.NewStore(pool), emailauth.Options{}),
		Users:  q,
		Jobs:   jc,
		Audit:  audit.New(pool),
	}, limiter, logger).Register(api)
	NewEmailVerify(cfg, EmailVerifyDeps{
		Codes:    emailauth.New(emailauth.NewStore(pool), emailauth.Options{}),
		Users:    NewPGSignInUsers(pool),
		Sessions: sessions,
		PreAuth:  NewValkeyPreAuthStore(vk),
		Audit:    audit.New(pool),
	}, limiter, logger).Register(api)
	NewAccount(account.New(pool, account.NoMemberships{}), logger).Register(api)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// do sends a JSON request and decodes a 2xx body into out, or the
	// problem otherwise.
	do := func(t *testing.T, method, path, bearer string, body, out any) (int, Problem) {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			rd = bytes.NewReader(b)
		}
		req, err := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("User-Agent", userAgent)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		var p Problem
		switch {
		case resp.StatusCode >= 300:
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
			}
		case out != nil:
			if err := json.Unmarshal(raw, out); err != nil {
				t.Fatalf("%s %s: decode %s: %v", method, path, raw, err)
			}
		}
		return resp.StatusCode, p
	}

	// emailedCode starts a sign-in and waits for the log provider to write
	// the auth_code email the worker sent for it, returning its code.
	codeRE := regexp.MustCompile(`\b(\d{6})\b`)
	seen := 0
	emailedCode := func(t *testing.T, intent string) string {
		t.Helper()
		var started EmailStartResponse
		if status, p := do(t, http.MethodPost, AuthPrefix+"/email/start", "", map[string]any{"email": addr, "intent": intent}, &started); status != http.StatusOK || !started.Sent {
			t.Fatalf("start: %d %+v %+v", status, started, p)
		}
		deadline := time.Now().Add(20 * time.Second)
		for {
			var msgs []map[string]any
			sc := bufio.NewScanner(strings.NewReader(mail.String()))
			sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
			for sc.Scan() {
				var m map[string]any
				if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
					t.Fatalf("log line %q: %v", sc.Text(), err)
				}
				if m["template"] == email.TemplateAuthCode && m["to"] == addr {
					msgs = append(msgs, m)
				}
			}
			if len(msgs) > seen {
				if len(msgs) != seen+1 {
					t.Fatalf("auth_code emails = %d, want %d", len(msgs), seen+1)
				}
				seen = len(msgs)
				m := msgs[len(msgs)-1]
				subject, _ := m["subject"].(string)
				text, _ := m["text"].(string)
				code := codeRE.FindString(subject)
				if code == "" || !strings.Contains(text, code) {
					t.Fatalf("no code in email: subject %q text %q", subject, text)
				}
				return code
			}
			if time.Now().After(deadline) {
				t.Fatalf("no auth_code email logged within 20s; log: %s", mail.String())
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	signIn := func(t *testing.T, intent string) SignInResponse {
		t.Helper()
		code := emailedCode(t, intent)
		var out SignInResponse
		if status, p := do(t, http.MethodPost, AuthPrefix+"/email/verify", "", map[string]any{"email": addr, "code": code, "remember": true}, &out); status != http.StatusOK {
			t.Fatalf("verify: %d %+v", status, p)
		}
		if out.Status != "" || out.AccessToken == "" || out.RefreshToken == "" || out.User == nil || out.User.Email != addr || !out.User.EmailVerified {
			t.Fatalf("verify body = %+v", out)
		}
		// A code works once.
		if status, p := do(t, http.MethodPost, AuthPrefix+"/email/verify", "", map[string]any{"email": addr, "code": code}, nil); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
			t.Fatalf("code reuse: %d %+v", status, p)
		}
		return out
	}
	refresh := func(t *testing.T, raw string) (int, TokenResponse, Problem) {
		t.Helper()
		var out TokenResponse
		status, p := do(t, http.MethodPost, AuthPrefix+"/refresh", "", map[string]any{"refresh_token": raw}, &out)
		return status, out, p
	}
	me := func(t *testing.T, access string) (int, Me) {
		t.Helper()
		var out Me
		status, _ := do(t, http.MethodGet, MePath, access, nil, &out)
		return status, out
	}
	family := func(t *testing.T, access string) (uuid.UUID, []db.Session) {
		t.Helper()
		claims, err := issuer.Verify(access)
		if err != nil {
			t.Fatal(err)
		}
		var fam uuid.UUID
		if err := pool.QueryRow(ctx, `SELECT family_id FROM sessions WHERE id = $1`, claims.SessionID).Scan(&fam); err != nil {
			t.Fatal(err)
		}
		rows, err := pool.Query(ctx, `SELECT id, revoked_at, revoked_reason FROM sessions WHERE family_id = $1 ORDER BY created_at`, fam)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []db.Session
		for rows.Next() {
			var s db.Session
			if err := rows.Scan(&s.ID, &s.RevokedAt, &s.RevokedReason); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return fam, out
	}

	var userID uuid.UUID
	var first SignInResponse

	t.Run("start, code, verify, me", func(t *testing.T) {
		first = signIn(t, string(emailauth.IntentSignUp))
		u, err := q.GetUserByEmail(ctx, addr)
		if err != nil {
			t.Fatal(err)
		}
		userID = u.ID
		if first.User.ID != u.ID.String() || u.EmailVerifiedAt == nil {
			t.Fatalf("user = %+v, body user = %+v", u, first.User)
		}
		status, m := me(t, first.AccessToken)
		if status != http.StatusOK || m.ID != u.ID.String() || m.Email != addr || !m.EmailVerified || !slices.Equal(m.AMR, []string{token.AMREmail}) {
			t.Fatalf("me: %d %+v", status, m)
		}
		if status, _ := me(t, ""); status != http.StatusUnauthorized {
			t.Fatalf("me without a token: %d", status)
		}
	})

	t.Run("refresh, then reuse revokes the family", func(t *testing.T) {
		if userID == uuid.Nil {
			t.Skip("sign-in failed")
		}
		status, rotated, p := refresh(t, first.RefreshToken)
		if status != http.StatusOK || rotated.AccessToken == "" || rotated.RefreshToken == "" ||
			rotated.RefreshToken == first.RefreshToken || rotated.User.ID != userID.String() {
			t.Fatalf("refresh: %d %+v %+v", status, rotated, p)
		}
		if status, m := me(t, rotated.AccessToken); status != http.StatusOK || m.ID != userID.String() {
			t.Fatalf("me with refreshed token: %d %+v", status, m)
		}

		// Replaying the rotated-out token is reuse: the whole family ends.
		if status, _, p := refresh(t, first.RefreshToken); status != http.StatusUnauthorized || p.Code != CodeInvalidToken {
			t.Fatalf("reuse: %d %+v", status, p)
		}
		if status, _, p := refresh(t, rotated.RefreshToken); status != http.StatusUnauthorized || p.Code != CodeSessionExpired {
			t.Fatalf("refresh after reuse: %d %+v", status, p)
		}
		_, rows := family(t, rotated.AccessToken)
		if len(rows) != 2 {
			t.Fatalf("family rows = %d, want 2", len(rows))
		}
		for _, r := range rows {
			if r.RevokedAt == nil {
				t.Fatalf("session %s still live after reuse", r.ID)
			}
		}
		if r := rows[1].RevokedReason; r == nil || *r != session.ReasonReuse {
			t.Fatalf("child revoked_reason = %v, want %q", r, session.ReasonReuse)
		}
		// Both access tokens of the family are denylisted in this process.
		for _, access := range []string{first.AccessToken, rotated.AccessToken} {
			if status, _ := me(t, access); status != http.StatusUnauthorized {
				t.Fatalf("me after reuse: %d, want 401", status)
			}
		}
	})

	t.Run("sign in again, then logout", func(t *testing.T) {
		if userID == uuid.Nil {
			t.Skip("sign-in failed")
		}
		second := signIn(t, string(emailauth.IntentSignIn))
		if second.User.ID != userID.String() {
			t.Fatalf("second sign-in user = %+v", second.User)
		}
		if status, _ := me(t, second.AccessToken); status != http.StatusOK {
			t.Fatalf("me: %d", status)
		}
		if status, p := do(t, http.MethodPost, AuthPrefix+"/logout", "", map[string]any{"refresh_token": second.RefreshToken}, nil); status != http.StatusNoContent {
			t.Fatalf("logout: %d %+v", status, p)
		}
		if status, _, p := refresh(t, second.RefreshToken); status != http.StatusUnauthorized || p.Code != CodeSessionExpired {
			t.Fatalf("refresh after logout: %d %+v", status, p)
		}
		if status, _ := me(t, second.AccessToken); status != http.StatusUnauthorized {
			t.Fatalf("me after logout: %d, want 401", status)
		}
		_, rows := family(t, second.AccessToken)
		if len(rows) != 1 || rows[0].RevokedAt == nil || rows[0].RevokedReason == nil || *rows[0].RevokedReason != session.ReasonLogout {
			t.Fatalf("family after logout = %+v", rows)
		}
		// Logout is idempotent.
		if status, p := do(t, http.MethodPost, AuthPrefix+"/logout", "", map[string]any{"refresh_token": second.RefreshToken}, nil); status != http.StatusNoContent {
			t.Fatalf("second logout: %d %+v", status, p)
		}
	})

	t.Run("audit trail", func(t *testing.T) {
		if userID == uuid.Nil {
			t.Skip("sign-in failed")
		}
		rows, err := pool.Query(ctx, `SELECT event, ip, user_agent, metadata FROM audit_events WHERE user_id = $1 OR metadata->>'email' = $2 ORDER BY id`, userID, addr)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		type event struct {
			kind string
			meta map[string]any
		}
		var got []event
		for rows.Next() {
			var (
				e  db.AuditEvent
				ev event
			)
			if err := rows.Scan(&e.Event, &e.Ip, &e.UserAgent, &e.Metadata); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(e.Metadata, &ev.meta); err != nil {
				t.Fatal(err)
			}
			// Every event was recorded with the HTTP client of its request.
			if e.Ip == nil || !e.Ip.IsLoopback() || e.UserAgent != userAgent {
				t.Fatalf("%s: ip %v user agent %q", e.Event, e.Ip, e.UserAgent)
			}
			ev.kind = e.Event
			got = append(got, ev)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		var kinds []string
		for _, e := range got {
			kinds = append(kinds, e.kind)
		}
		want := []string{
			string(audit.LoginRequested), string(audit.UserCreated), string(audit.LoginSucceeded),
			string(audit.LoginFailed), // the code replayed
			string(audit.SessionReuseDetected),
			string(audit.LoginRequested), string(audit.LoginSucceeded),
			string(audit.LoginFailed),
			string(audit.SessionRevoked),
		}
		if !slices.Equal(kinds, want) {
			t.Fatalf("audit events = %v, want %v", kinds, want)
		}
		if got[0].meta["intent"] != string(emailauth.IntentSignUp) || got[5].meta["intent"] != string(emailauth.IntentSignIn) ||
			got[0].meta["email_sent"] != true || got[5].meta["email_sent"] != true {
			t.Fatalf("login.requested metadata = %v, %v", got[0].meta, got[5].meta)
		}
		for _, i := range []int{3, 7} {
			if got[i].meta["reason"] != string(CodeInvalidCode) {
				t.Fatalf("login.failed metadata = %v", got[i].meta)
			}
		}
		if got[4].meta["revoked"] != float64(1) {
			t.Fatalf("session.reuse_detected metadata = %v, want 1 live session revoked", got[4].meta)
		}
		if got[8].meta["reason"] != session.ReasonLogout {
			t.Fatalf("session.revoked metadata = %v", got[8].meta)
		}
	})
}
