package identity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/recovery"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// fakeRecovery is a scripted RecoveryService.
type fakeRecovery struct {
	requested []string
	status    recovery.Status
	user      db.User
	err       error
}

func (f *fakeRecovery) Request(_ context.Context, addr string) error {
	f.requested = append(f.requested, addr)
	return f.err
}

func (f *fakeRecovery) Status(context.Context, string) (recovery.Status, error) {
	return f.status, f.err
}

func (f *fakeRecovery) Confirm(context.Context, string) (db.User, error) {
	return f.user, f.err
}

func (f *fakeRecovery) Cancel(context.Context, string) error { return f.err }

// fakeRecoverySessions returns fixed tokens for any user.
type fakeRecoverySessions struct {
	created []db.User
	metas   []session.Meta
}

func (f *fakeRecoverySessions) Create(_ context.Context, u db.User, _ bool, m session.Meta) (session.Tokens, error) {
	f.created = append(f.created, u)
	f.metas = append(f.metas, m)
	return session.Tokens{AccessToken: "at", RefreshToken: "rt", AccessExpiresAt: time.Now().Add(15 * time.Minute), User: u}, nil
}

// newTestRecovery serves the recovery endpoints over svc with rate limits
// off.
func newTestRecovery(t *testing.T, svc *fakeRecovery) (humatest.TestAPI, *fakeRecoverySessions) {
	t.Helper()
	limiter, err := ratelimit.New(nil, discardLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	sessions := &fakeRecoverySessions{}
	_, api := humatest.New(t)
	NewRecovery(config.IdentityConfig{}, svc, sessions, limiter, discardLogger()).Register(api)
	return api, sessions
}

func TestRecoveryRequestAlwaysSent(t *testing.T) {
	svc := &fakeRecovery{}
	api, _ := newTestRecovery(t, svc)
	resp := api.Post(RecoveryPrefix+"/request", map[string]any{"email": " Lost@Example.com "})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var out struct {
		Sent bool `json:"sent"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil || !out.Sent {
		t.Fatalf("body = %s (%v)", resp.Body, err)
	}
	if len(svc.requested) != 1 || svc.requested[0] != "lost@example.com" {
		t.Fatalf("requested = %v", svc.requested)
	}

	resp = api.Post(RecoveryPrefix+"/request", map[string]any{"email": "lost@localhost"})
	if resp.Code != http.StatusBadRequest || problemCodeOf(t, resp.Body.Bytes()) != CodeInvalidRequest {
		t.Fatalf("undotted domain: %d %s", resp.Code, resp.Body)
	}

	svc.err = errors.New("db down")
	if resp := api.Post(RecoveryPrefix+"/request", map[string]any{"email": "lost@example.com"}); resp.Code != http.StatusInternalServerError {
		t.Fatalf("service error: %d", resp.Code)
	}
}

func TestRecoveryStatus(t *testing.T) {
	requested := time.Date(2026, 11, 4, 9, 0, 0, 0, time.FixedZone("x", 3600))
	svc := &fakeRecovery{status: recovery.Status{State: recovery.StatePending, RequestedAt: requested, ReadyAt: requested.Add(24 * time.Hour)}}
	api, _ := newTestRecovery(t, svc)
	resp := api.Get(RecoveryPrefix + "/status?token=abc")
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var out struct {
		Status      string    `json:"status"`
		RequestedAt time.Time `json:"requested_at"`
		ReadyAt     time.Time `json:"ready_at"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "pending" || !out.RequestedAt.Equal(requested) || !out.ReadyAt.Equal(requested.Add(24*time.Hour)) {
		t.Fatalf("body = %s", resp.Body)
	}
	if resp := api.Get(RecoveryPrefix + "/status"); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("no token: %d", resp.Code)
	}
	svc.err = recovery.ErrInvalidToken
	if resp := api.Get(RecoveryPrefix + "/status?token=abc"); resp.Code != http.StatusUnauthorized || problemCodeOf(t, resp.Body.Bytes()) != CodeInvalidToken {
		t.Fatalf("unknown token: %d %s", resp.Code, resp.Body)
	}
}

func TestRecoveryConfirm(t *testing.T) {
	u := db.User{ID: uuid.New(), Email: "lost@example.com"}
	svc := &fakeRecovery{user: u}
	api, sessions := newTestRecovery(t, svc)
	resp := api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": "abc"})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var out TokenResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.AccessToken != "at" || out.RefreshToken != "rt" || out.User.ID != u.ID.String() {
		t.Fatalf("body = %s", resp.Body)
	}
	if len(sessions.created) != 1 || sessions.created[0].ID != u.ID || len(sessions.metas[0].AMR) != 1 || sessions.metas[0].AMR[0] != "email" {
		t.Fatalf("sessions = %+v %+v", sessions.created, sessions.metas)
	}

	svc.err = &recovery.NotReadyError{ReadyAt: time.Now().Add(time.Hour), Wait: time.Hour}
	resp = api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": "abc"})
	if resp.Code != http.StatusConflict {
		t.Fatalf("not ready: %d %s", resp.Code, resp.Body)
	}
	var p problemBody
	if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != CodeRecoveryNotReady || p.RetryAfter != 3600 || resp.Header().Get("Retry-After") != "3600" {
		t.Fatalf("not ready body = %s", resp.Body)
	}

	svc.err = recovery.ErrInvalidToken
	if resp := api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": "abc"}); resp.Code != http.StatusUnauthorized || problemCodeOf(t, resp.Body.Bytes()) != CodeInvalidToken {
		t.Fatalf("invalid token: %d %s", resp.Code, resp.Body)
	}
	if len(sessions.created) != 1 {
		t.Fatal("a session was created for a failed confirm")
	}
}

func TestRecoveryCancel(t *testing.T) {
	svc := &fakeRecovery{}
	api, _ := newTestRecovery(t, svc)
	if resp := api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": "abc"}); resp.Code != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", resp.Code, resp.Body)
	}
	svc.err = recovery.ErrInvalidToken
	if resp := api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": "abc"}); resp.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token: %d %s", resp.Code, resp.Body)
	}
	svc.err = errors.New("db down")
	if resp := api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": "abc"}); resp.Code != http.StatusInternalServerError {
		t.Fatalf("service error: %d", resp.Code)
	}
}

// The rate limiter fails closed: with limits configured and no Valkey,
// every recovery endpoint refuses rather than running unlimited.
func TestRecoveryRateLimitedFailsClosed(t *testing.T) {
	limiter, err := ratelimit.New(nil, discardLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.IdentityConfig{}
	cfg.RateLimits.RecoveryPerIP = config.RateLimit{Limit: 5, Window: time.Minute}
	cfg.RateLimits.RecoveryRequestPerEmail = config.RateLimit{Limit: 5, Window: time.Minute}
	svc := &fakeRecovery{}
	_, api := humatest.New(t)
	NewRecovery(cfg, svc, &fakeRecoverySessions{}, limiter, discardLogger()).Register(api)
	for name, code := range map[string]int{
		"request": api.Post(RecoveryPrefix+"/request", map[string]any{"email": "lost@example.com"}).Code,
		"status":  api.Get(RecoveryPrefix + "/status?token=abc").Code,
		"confirm": api.Post(RecoveryPrefix+"/confirm", map[string]any{"token": "abc"}).Code,
		"cancel":  api.Post(RecoveryPrefix+"/cancel", map[string]any{"token": "abc"}).Code,
	} {
		if code != http.StatusServiceUnavailable {
			t.Errorf("%s: status = %d, want 503", name, code)
		}
	}
	if len(svc.requested) != 0 {
		t.Fatal("service called without a rate limit check")
	}
}

func problemCodeOf(t *testing.T, body []byte) ErrCode {
	t.Helper()
	var p problemBody
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return p.Code
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
