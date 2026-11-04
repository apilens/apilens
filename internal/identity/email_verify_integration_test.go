//go:build integration

package identity

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	signingkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestEmailVerifyIntegration runs POST /auth/email/verify against Postgres
// (users, auth_email_tokens, sessions, user_totp, audit_events) and Valkey
// (pre-auth tokens), with real codes, sessions and access tokens.
func TestEmailVerifyIntegration(t *testing.T) {
	const (
		refreshTTL      = 720 * time.Hour
		refreshTTLShort = 24 * time.Hour
	)
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	// Every log line is kept so the link-token test can grep it.
	logs := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(io.MultiWriter(logs, testLogWriter{t}), &slog.HandlerOptions{Level: slog.LevelDebug}))

	priv, err := rsa.GenerateKey(rand.Reader, signingkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	keyNow := time.Now()
	k, err := signingkeys.Unstored(priv, &keyNow, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(itestKeys{k}, token.Options{Issuer: "https://id.example.com", TTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.New(pool, issuer, session.Options{RefreshTTL: refreshTTL, RefreshTTLShort: refreshTTLShort}, logger)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := ratelimit.New(vk, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	// The code clock can be moved forward to expire an email.
	var (
		mu   sync.Mutex
		skew time.Duration
	)
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return time.Now().Add(skew)
	}
	codes := emailauth.New(emailauth.NewStore(pool), emailauth.Options{Now: clock})

	cfg := config.IdentityConfig{PreAuthTTL: 5 * time.Minute, PublicUIURL: "http://localhost:3000"}
	cfg.RateLimits.CodeVerifyPerEmail = config.RateLimit{Limit: 100, Window: time.Minute}
	_, api := humatest.New(t)
	NewEmailVerify(cfg, EmailVerifyDeps{
		Codes:    codes,
		Users:    NewPGSignInUsers(pool),
		Sessions: sessions,
		PreAuth:  NewValkeyPreAuthStore(vk),
		Audit:    audit.New(pool),
	}, limiter, logger).Register(api)

	issueFull := func(addr string, intent emailauth.Intent, next string) emailauth.Issued {
		t.Helper()
		opts := emailauth.IssueOptions{}
		if next != "" {
			opts.NextPath = &next
		}
		iss, err := codes.Issue(ctx, addr, intent, opts)
		if err != nil {
			t.Fatal(err)
		}
		return iss
	}
	issue := func(addr string, intent emailauth.Intent, next string) string {
		t.Helper()
		return issueFull(addr, intent, next).Code
	}
	verifyLink := func(tok string, remember bool) (int, SignInResponse, Problem) {
		t.Helper()
		r := api.Post(AuthPrefix+"/email/verify-link", map[string]any{"token": tok, "remember": remember})
		var ok SignInResponse
		var p Problem
		if r.Code == http.StatusOK {
			if err := json.Unmarshal(r.Body.Bytes(), &ok); err != nil {
				t.Fatal(err)
			}
		} else if err := json.Unmarshal(r.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return r.Code, ok, p
	}
	verify := func(addr, code string, remember bool) (int, SignInResponse, Problem) {
		t.Helper()
		r := api.Post(AuthPrefix+"/email/verify", map[string]any{"email": addr, "code": code, "remember": remember})
		var ok SignInResponse
		var p Problem
		if r.Code == http.StatusOK {
			if err := json.Unmarshal(r.Body.Bytes(), &ok); err != nil {
				t.Fatal(err)
			}
		} else if err := json.Unmarshal(r.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return r.Code, ok, p
	}
	events := func(user uuid.UUID, kind audit.Kind) int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE user_id = $1 AND event = $2`, user, string(kind)).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	sessionOf := func(t *testing.T, body SignInResponse) (*token.Claims, db.Session) {
		t.Helper()
		claims, err := issuer.Verify(body.AccessToken)
		if err != nil {
			t.Fatal(err)
		}
		var sess db.Session
		if err := pool.QueryRow(ctx, `SELECT id, remember, amr, expires_at FROM sessions WHERE id = $1`, claims.SessionID).
			Scan(&sess.ID, &sess.Remember, &sess.Amr, &sess.ExpiresAt); err != nil {
			t.Fatal(err)
		}
		return claims, sess
	}

	t.Run("new user", func(t *testing.T) {
		code := issue("new@example.com", emailauth.IntentSignUp, "/welcome")
		status, body, p := verify("New@Example.com", code, true)
		if status != http.StatusOK {
			t.Fatalf("status = %d %+v", status, p)
		}
		if body.Status != "" || body.AccessToken == "" || body.RefreshToken == "" || body.ExpiresIn != 900 || body.Next != "/welcome" {
			t.Fatalf("body = %+v", body)
		}
		user, err := q.GetUserByEmail(ctx, "new@example.com")
		if err != nil {
			t.Fatal(err)
		}
		if user.EmailVerifiedAt == nil || user.LastLoginAt == nil || body.User == nil || body.User.ID != user.ID.String() || !body.User.EmailVerified {
			t.Fatalf("user = %+v, body user = %+v", user, body.User)
		}
		if events(user.ID, audit.UserCreated) != 1 || events(user.ID, audit.LoginSucceeded) != 1 {
			t.Fatal("want user.created and login.succeeded audited once")
		}
		claims, sess := sessionOf(t, body)
		if !slices.Equal(claims.AMR, []string{"email"}) || !slices.Equal(sess.Amr, []string{"email"}) {
			t.Fatalf("amr = %v / %v, want [email]", claims.AMR, sess.Amr)
		}
		if !sess.Remember || sess.ExpiresAt.Before(time.Now().Add(refreshTTL-time.Hour)) {
			t.Fatalf("session remember=%v expires %v, want the long lifetime", sess.Remember, sess.ExpiresAt)
		}

		// The code is single use.
		if status, _, p := verify("new@example.com", code, true); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
			t.Fatalf("reuse: %d %+v", status, p)
		}
	})

	t.Run("returning user", func(t *testing.T) {
		existing, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "back@example.com", Name: "Back"})
		if err != nil {
			t.Fatal(err)
		}
		code := issue("back@example.com", emailauth.IntentSignIn, "")
		status, body, p := verify("back@example.com", code, false)
		if status != http.StatusOK {
			t.Fatalf("status = %d %+v", status, p)
		}
		if body.User == nil || body.User.ID != existing.ID.String() || body.User.Name != "Back" || body.Next != "" {
			t.Fatalf("body = %+v", body)
		}
		user, err := q.GetUserByID(ctx, existing.ID)
		if err != nil {
			t.Fatal(err)
		}
		if user.EmailVerifiedAt == nil {
			t.Fatal("email_verified_at not set")
		}
		if events(existing.ID, audit.UserCreated) != 0 || events(existing.ID, audit.LoginSucceeded) != 1 {
			t.Fatal("returning user: want no user.created, one login.succeeded")
		}
		_, sess := sessionOf(t, body)
		if sess.Remember || sess.ExpiresAt.After(time.Now().Add(refreshTTLShort+time.Minute)) {
			t.Fatalf("session remember=%v expires %v, want the short lifetime", sess.Remember, sess.ExpiresAt)
		}
	})

	t.Run("wrong code five times locks", func(t *testing.T) {
		code := issue("guess@example.com", emailauth.IntentSignUp, "")
		wrong := "000000"
		if code == wrong {
			wrong = "111111"
		}
		for i := 1; i <= emailauth.MaxAttempts; i++ {
			status, _, p := verify("guess@example.com", wrong, false)
			want, wantStatus := CodeInvalidCode, http.StatusBadRequest
			if i == emailauth.MaxAttempts {
				want, wantStatus = CodeTooManyAttempts, http.StatusTooManyRequests
			}
			if status != wantStatus || p.Code != want {
				t.Fatalf("guess %d: %d %+v, want %d %s", i, status, p, wantStatus, want)
			}
		}
		// Locked: even the right code fails now.
		if status, _, p := verify("guess@example.com", code, false); status != http.StatusTooManyRequests || p.Code != CodeTooManyAttempts {
			t.Fatalf("right code after lockout: %d %+v", status, p)
		}
		if _, err := q.GetUserByEmail(ctx, "guess@example.com"); err == nil {
			t.Fatal("user created without a valid code")
		}
		var failed int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE event = 'login.failed' AND metadata->>'email' = 'guess@example.com'`).Scan(&failed); err != nil || failed != 6 {
			t.Fatalf("login.failed events = %d (%v), want 6", failed, err)
		}
	})

	t.Run("expired", func(t *testing.T) {
		code := issue("late@example.com", emailauth.IntentSignUp, "")
		mu.Lock()
		skew = emailauth.TTL + time.Second
		mu.Unlock()
		t.Cleanup(func() { mu.Lock(); skew = 0; mu.Unlock() })
		if status, _, p := verify("late@example.com", code, false); status != http.StatusBadRequest || p.Code != CodeCodeExpired {
			t.Fatalf("expired code: %d %+v", status, p)
		}
	})

	t.Run("two-factor required", func(t *testing.T) {
		user, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "mfa@example.com"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := q.UpsertPendingTOTP(ctx, db.UpsertPendingTOTPParams{UserID: user.ID, SecretEnc: []byte("sealed")}); err != nil {
			t.Fatal(err)
		}
		if _, err := q.ConfirmTOTP(ctx, user.ID); err != nil {
			t.Fatal(err)
		}
		code := issue("mfa@example.com", emailauth.IntentSignIn, "/acme")
		status, body, p := verify("mfa@example.com", code, true)
		if status != http.StatusOK {
			t.Fatalf("status = %d %+v", status, p)
		}
		if body.Status != TwoFactorRequiredStatus || body.PreAuthToken == "" || body.Next != "/acme" ||
			body.AccessToken != "" || body.RefreshToken != "" || body.User != nil {
			t.Fatalf("body = %+v", body)
		}
		raw, err := vk.Do(ctx, vk.B().Get().Key(PreAuthKey(body.PreAuthToken)).Build()).AsBytes()
		if err != nil {
			t.Fatal(err)
		}
		var pre PreAuth
		if err := json.Unmarshal(raw, &pre); err != nil {
			t.Fatal(err)
		}
		if pre.UserID != user.ID || !slices.Equal(pre.AMR, []string{"email"}) || !pre.Remember || pre.Next != "/acme" {
			t.Fatalf("pre-auth = %+v", pre)
		}
		ttl, err := vk.Do(ctx, vk.B().Ttl().Key(PreAuthKey(body.PreAuthToken)).Build()).AsInt64()
		if err != nil || ttl <= 0 || ttl > 300 {
			t.Fatalf("pre-auth ttl = %d (%v)", ttl, err)
		}
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM sessions WHERE user_id = $1`, user.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("sessions = %d (%v), want none before the second factor", n, err)
		}
	})

	t.Run("magic link", func(t *testing.T) {
		iss := issueFull("link@example.com", emailauth.IntentSignUp, "/from-link")

		// The GET helper only redirects; the token still works afterwards.
		r := api.Get(AuthPrefix + "/email/link?token=" + iss.LinkToken)
		if r.Code != http.StatusFound || r.Header().Get("Location") != "http://localhost:3000/verify?token="+iss.LinkToken {
			t.Fatalf("GET link: %d Location %q", r.Code, r.Header().Get("Location"))
		}

		status, body, p := verifyLink(iss.LinkToken, true)
		if status != http.StatusOK {
			t.Fatalf("status = %d %+v", status, p)
		}
		if body.AccessToken == "" || body.RefreshToken == "" || body.Next != "/from-link" {
			t.Fatalf("body = %+v", body)
		}
		user, err := q.GetUserByEmail(ctx, "link@example.com")
		if err != nil {
			t.Fatal(err)
		}
		if user.EmailVerifiedAt == nil || body.User == nil || body.User.ID != user.ID.String() {
			t.Fatalf("user = %+v, body user = %+v", user, body.User)
		}
		if events(user.ID, audit.UserCreated) != 1 || events(user.ID, audit.LoginSucceeded) != 1 {
			t.Fatal("want user.created and login.succeeded audited once")
		}
		claims, sess := sessionOf(t, body)
		if !slices.Equal(claims.AMR, []string{"email"}) || !sess.Remember {
			t.Fatalf("amr = %v remember = %v", claims.AMR, sess.Remember)
		}

		// Reused link: invalid_token. The code of the same email is spent too.
		if status, _, p := verifyLink(iss.LinkToken, true); status != http.StatusUnauthorized || p.Code != CodeInvalidToken {
			t.Fatalf("reuse: %d %+v", status, p)
		}
		if status, _, p := verify("link@example.com", iss.Code, true); status != http.StatusBadRequest || p.Code != CodeInvalidCode {
			t.Fatalf("code after link: %d %+v", status, p)
		}

		// A link superseded by a newer email: invalid_token.
		old := issueFull("link@example.com", emailauth.IntentSignIn, "")
		_ = issueFull("link@example.com", emailauth.IntentSignIn, "")
		if status, _, p := verifyLink(old.LinkToken, false); status != http.StatusUnauthorized || p.Code != CodeInvalidToken {
			t.Fatalf("superseded: %d %+v", status, p)
		}

		// A link sent to change an address does not sign in.
		chg := issueFull("change@example.com", emailauth.IntentChangeEmail, "")
		if status, _, p := verifyLink(chg.LinkToken, false); status != http.StatusUnauthorized || p.Code != CodeInvalidToken {
			t.Fatalf("change_email link: %d %+v", status, p)
		}

		for _, tok := range []string{iss.LinkToken, old.LinkToken, chg.LinkToken} {
			if strings.Contains(logs.String(), tok) {
				t.Fatalf("link token logged: %s", logs.String())
			}
		}
	})

	t.Run("magic link expired", func(t *testing.T) {
		iss := issueFull("late-link@example.com", emailauth.IntentSignIn, "")
		mu.Lock()
		skew = emailauth.TTL + time.Second
		mu.Unlock()
		t.Cleanup(func() { mu.Lock(); skew = 0; mu.Unlock() })
		if status, _, p := verifyLink(iss.LinkToken, false); status != http.StatusBadRequest || p.Code != CodeCodeExpired {
			t.Fatalf("expired link: %d %+v", status, p)
		}
		if _, err := q.GetUserByEmail(ctx, "late-link@example.com"); err == nil {
			t.Fatal("user created from an expired link")
		}
		if strings.Contains(logs.String(), iss.LinkToken) {
			t.Fatalf("link token logged: %s", logs.String())
		}
	})
}

// syncBuffer is a bytes.Buffer safe for concurrent log writes.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// testLogWriter echoes log lines to the test log under -v.
type testLogWriter struct{ t *testing.T }

func (w testLogWriter) Write(p []byte) (int, error) {
	if testing.Verbose() {
		w.t.Log(strings.TrimRight(string(p), "\n"))
	}
	return len(p), nil
}
