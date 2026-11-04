//go:build integration

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/recovery"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// fakeClock is a settable clock for the cooling-off period.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type recoveryFixture struct {
	*twoFactorFixture
	clock *fakeClock
	rjobs *recordingJobs
}

// setupRecovery serves the 2FA endpoints (to turn 2FA on) and the recovery
// endpoints over real Postgres, with a fake clock for recovery and the
// given limiter (rate limits off when cfg sets none).
func setupRecovery(t *testing.T, cfg config.IdentityConfig, limiter *ratelimit.Limiter) *recoveryFixture {
	t.Helper()
	f := setupTwoFactor(t)
	if limiter == nil {
		var err error
		if limiter, err = ratelimit.New(nil, testutil.Logger(t), nil); err != nil {
			t.Fatal(err)
		}
	}
	clock := &fakeClock{now: time.Now()}
	jobs := &recordingJobs{}
	svc := recovery.New(f.pool, jobs, recovery.Options{Delay: 24 * time.Hour, Now: clock.Now})
	NewRecovery(cfg, svc, f.sessions, limiter, testutil.Logger(t)).Register(f.api)
	return &recoveryFixture{twoFactorFixture: f, clock: clock, rjobs: jobs}
}

func (f *recoveryFixture) request(t *testing.T, addr string) {
	t.Helper()
	resp := f.api.Post(RecoveryPrefix+"/request", map[string]any{"email": addr})
	if resp.Code != http.StatusOK {
		t.Fatalf("request %s: %d %s", addr, resp.Code, resp.Body)
	}
}

// lastEmail returns the last recovery job's email and the number sent.
func (f *recoveryFixture) lastEmail(t *testing.T) (email.SendArgs, int) {
	t.Helper()
	sent := f.rjobs.emails()
	if len(sent) == 0 {
		t.Fatal("no recovery email")
	}
	return sent[len(sent)-1], len(sent)
}

func (f *recoveryFixture) status(t *testing.T, tok string) string {
	t.Helper()
	resp := f.api.Get(RecoveryPrefix + "/status?token=" + tok)
	if resp.Code != http.StatusOK {
		t.Fatalf("status: %d %s", resp.Code, resp.Body)
	}
	var out struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Status
}

func (f *recoveryFixture) totpRows(t *testing.T, user uuid.UUID) (secrets, codes int) {
	t.Helper()
	if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM user_totp WHERE user_id = $1), (SELECT count(*) FROM backup_codes WHERE user_id = $1)`, user).Scan(&secrets, &codes); err != nil {
		t.Fatal(err)
	}
	return secrets, codes
}

func TestRecoveryRequestRevealsNothing(t *testing.T) {
	f := setupRecovery(t, config.IdentityConfig{}, nil)
	// No account, and an account without 2FA: the same answer, no email.
	f.request(t, "nobody@example.com")
	u, _ := f.signIn(t, "no2fa@example.com")
	f.request(t, "no2fa@example.com")
	if n := len(f.rjobs.emails()); n != 0 {
		t.Fatalf("emails = %d, want 0", n)
	}
	if n := len(f.events(t, u.ID, audit.RecoveryRequested)); n != 0 {
		t.Fatalf("recovery.requested = %d", n)
	}
	var n int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM recovery_requests`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("requests = %d (%v)", n, err)
	}
}

func TestRecoveryConfirmAfterCoolingOff(t *testing.T) {
	f := setupRecovery(t, config.IdentityConfig{}, nil)
	const addr = "lost@example.com"
	u, auth := f.signIn(t, addr)
	f.confirm(t, auth)

	f.request(t, "Lost@Example.com")
	sent, _ := f.lastEmail(t)
	tok, _ := sent.Data["token"].(string)
	if sent.To != addr || sent.Template != email.TemplateRecoveryRequested || tok == "" ||
		sent.Data["ready_at"] != f.clock.Now().Add(24*time.Hour).UTC().Format(time.RFC3339) || sent.Data["ip"] == "" {
		t.Fatalf("email = %+v", sent)
	}
	var stored string
	if err := f.pool.QueryRow(f.ctx, `SELECT token_hash FROM recovery_requests WHERE user_id = $1`, u.ID).Scan(&stored); err != nil || stored != recovery.Hash(tok) || stored == tok {
		t.Fatalf("token_hash = %q (%v)", stored, err)
	}
	if evs := f.events(t, u.ID, audit.RecoveryRequested); len(evs) != 1 {
		t.Fatalf("recovery.requested = %d", len(evs))
	}
	if s := f.status(t, tok); s != "pending" {
		t.Fatalf("status = %s, want pending", s)
	}

	// Before the cooling-off period ends: refused with the remaining wait.
	f.clock.Advance(23 * time.Hour)
	resp := f.api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": tok})
	var p problemBody
	_ = json.Unmarshal(resp.Body.Bytes(), &p)
	if resp.Code != http.StatusConflict || p.Code != CodeRecoveryNotReady || p.RetryAfter != 3600 {
		t.Fatalf("early confirm: %d %s", resp.Code, resp.Body)
	}
	if secrets, _ := f.totpRows(t, u.ID); secrets != 1 {
		t.Fatal("early confirm removed 2FA")
	}

	// After it: 2FA off, every session revoked, a fresh session issued.
	f.clock.Advance(time.Hour)
	if s := f.status(t, tok); s != "ready" {
		t.Fatalf("status = %s, want ready", s)
	}
	resp = f.api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": tok})
	if resp.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", resp.Code, resp.Body)
	}
	var out TokenResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil || out.AccessToken == "" || out.RefreshToken == "" || out.User.ID != u.ID.String() {
		t.Fatalf("confirm body = %s (%v)", resp.Body, err)
	}
	if secrets, codes := f.totpRows(t, u.ID); secrets != 0 || codes != 0 {
		t.Fatalf("after recovery: %d secrets, %d backup codes", secrets, codes)
	}
	var revoked int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_reason = $2`, u.ID, session.ReasonRecovered).Scan(&revoked); err != nil || revoked != 1 {
		t.Fatalf("revoked sessions = %d (%v)", revoked, err)
	}
	// The old session is gone; the new one works and sees 2FA off.
	expectProblem(t, "old session", f.api.Get(TwoFactorPrefix+"/status", auth), http.StatusUnauthorized, CodeSessionExpired)
	if st := f.twoFactorFixture.status(t, "Authorization: Bearer "+out.AccessToken); st.Enabled {
		t.Fatalf("2fa still on: %+v", st)
	}
	if n := len(f.events(t, u.ID, audit.RecoveryConfirmed)); n != 1 {
		t.Fatalf("recovery.confirmed = %d", n)
	}
	if evs := f.events(t, u.ID, audit.TOTPDisabled); len(evs) != 1 || !jsonHas(evs[0].Metadata, "method", "recovery") {
		t.Fatalf("totp.disabled = %+v", evs)
	}
	alert, _ := f.lastEmail(t)
	if alert.Template != email.TemplateSecurityChange || alert.To != addr || alert.Data["change"] != email.SecurityChangeRecoveryCompleted {
		t.Fatalf("alert = %+v", alert)
	}
	if s := f.status(t, tok); s != "confirmed" {
		t.Fatalf("status = %s, want confirmed", s)
	}

	// The token works once.
	expectProblem(t, "replay", f.api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": tok}), http.StatusUnauthorized, CodeInvalidToken)
	expectProblem(t, "cancel confirmed", f.api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": tok}), http.StatusUnauthorized, CodeInvalidToken)
	expectProblem(t, "unknown", f.api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": "nope"}), http.StatusUnauthorized, CodeInvalidToken)
	expectProblem(t, "unknown status", f.api.Get(RecoveryPrefix+"/status?token=nope"), http.StatusUnauthorized, CodeInvalidToken)
}

func TestRecoveryCancelFlow(t *testing.T) {
	f := setupRecovery(t, config.IdentityConfig{}, nil)
	const addr = "cancel@example.com"
	u, auth := f.signIn(t, addr)
	f.confirm(t, auth)

	// A newer request replaces the older one.
	f.request(t, addr)
	first, _ := f.lastEmail(t)
	f.request(t, addr)
	second, n := f.lastEmail(t)
	if n != 2 {
		t.Fatalf("emails = %d, want 2", n)
	}
	firstTok, secondTok := first.Data["token"].(string), second.Data["token"].(string)
	if firstTok == secondTok {
		t.Fatal("same token twice")
	}
	if s := f.status(t, firstTok); s != "cancelled" {
		t.Fatalf("superseded status = %s", s)
	}

	// The cancel link stops it, also after the cooling-off period.
	if resp := f.api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": secondTok}); resp.Code != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", resp.Code, resp.Body)
	}
	if resp := f.api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": secondTok}); resp.Code != http.StatusNoContent {
		t.Fatalf("cancel again: %d %s", resp.Code, resp.Body)
	}
	if s := f.status(t, secondTok); s != "cancelled" {
		t.Fatalf("status = %s", s)
	}
	if evs := f.events(t, u.ID, audit.RecoveryCancelled); len(evs) != 1 {
		t.Fatalf("recovery.cancelled = %d, want 1", len(evs))
	}
	f.clock.Advance(25 * time.Hour)
	for _, tok := range []string{firstTok, secondTok} {
		expectProblem(t, "confirm cancelled", f.api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": tok}), http.StatusUnauthorized, CodeInvalidToken)
	}
	if secrets, codes := f.totpRows(t, u.ID); secrets != 1 || codes != 10 {
		t.Fatalf("cancelled recovery changed 2FA: %d secrets, %d codes", secrets, codes)
	}
	// The original session is untouched.
	if st := f.twoFactorFixture.status(t, auth); !st.Enabled {
		t.Fatalf("2fa off: %+v", st)
	}
}

func TestRecoveryRateLimited(t *testing.T) {
	ctx := context.Background()
	client, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	limiter, err := ratelimit.New(client, testutil.Logger(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.IdentityConfig{}
	cfg.RateLimits.RecoveryRequestPerEmail = config.RateLimit{Limit: 2, Window: time.Hour}
	cfg.RateLimits.RecoveryPerIP = config.RateLimit{Limit: 3, Window: time.Minute}
	f := setupRecovery(t, cfg, limiter)

	// Per email: the third request for one address is refused.
	f.request(t, "limited@example.com")
	f.request(t, "LIMITED@example.com")
	resp := f.api.Post(RecoveryPrefix+"/request", map[string]any{"email": "limited@example.com"})
	expectProblem(t, "third request", resp, http.StatusTooManyRequests, CodeRateLimited)
	if resp.Header().Get("Retry-After") == "" {
		t.Fatal("no Retry-After")
	}

	// Per IP: the token endpoints share one bucket.
	for range 3 {
		if resp := f.api.Get(RecoveryPrefix + "/status?token=nope"); resp.Code != http.StatusUnauthorized {
			t.Fatalf("status: %d", resp.Code)
		}
	}
	if resp := f.api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": "nope"}); resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") == "" {
		t.Fatalf("4th token call: %d", resp.Code)
	}
}

// jsonHas reports whether the JSON object raw has key set to want.
func jsonHas(raw []byte, key, want string) bool {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	return m[key] == want
}
