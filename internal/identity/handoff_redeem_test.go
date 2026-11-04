package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// failingHandoff is a HandoffStore whose Take always fails.
type failingHandoff struct{ err error }

func (f failingHandoff) Issue(context.Context, SignInResponse, time.Duration) (string, error) {
	return "", f.err
}

func (f failingHandoff) Take(context.Context, string) (SignInResponse, error) {
	return SignInResponse{}, f.err
}

func newHandoffAPI(t *testing.T, cfg config.IdentityConfig, store HandoffStore) humatest.TestAPI {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, err := ratelimit.New(nil, logger, nil) // zero rates: limits disabled
	if err != nil {
		t.Fatal(err)
	}
	_, api := humatest.New(t)
	NewHandoff(cfg, store, limiter, logger).Register(api)
	return api
}

func redeemHandoff(t *testing.T, api humatest.TestAPI, code string) (int, map[string]any) {
	t.Helper()
	resp := api.Post(AuthPrefix+"/handoff", map[string]any{"code": code})
	var out map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	return resp.Code, out
}

func TestHandoffRedeemsSessionOnce(t *testing.T) {
	store := &memHandoff{m: map[string]SignInResponse{}}
	bundle := SignInResponse{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresIn:    900,
		User:         &AuthUser{ID: "0193e5d2-0000-7000-8000-000000000001", Email: "ada@example.com"},
		Next:         "/projects",
	}
	code, err := store.Issue(context.Background(), bundle, HandoffTTL)
	if err != nil {
		t.Fatal(err)
	}
	api := newHandoffAPI(t, config.IdentityConfig{}, store)

	status, out := redeemHandoff(t, api, code)
	if status != http.StatusOK || out["access_token"] != "access" || out["refresh_token"] != "refresh" ||
		out["expires_in"] != float64(900) || out["next"] != "/projects" {
		t.Fatalf("first redeem: %d %v", status, out)
	}
	if u, _ := out["user"].(map[string]any); u["email"] != "ada@example.com" {
		t.Errorf("user = %v", out["user"])
	}
	if _, ok := out["status"]; ok {
		t.Errorf("session bundle carries status: %v", out)
	}

	status, out = redeemHandoff(t, api, code)
	if status != http.StatusUnauthorized || out["code"] != string(CodeInvalidToken) {
		t.Fatalf("second redeem: %d %v, want 401 invalid_token", status, out)
	}
}

func TestHandoffRedeemsTwoFactor(t *testing.T) {
	store := &memHandoff{m: map[string]SignInResponse{}}
	code, err := store.Issue(context.Background(), NewSignInTwoFactor("pre-auth", "/settings"), HandoffTTL)
	if err != nil {
		t.Fatal(err)
	}
	api := newHandoffAPI(t, config.IdentityConfig{}, store)
	status, out := redeemHandoff(t, api, code)
	want := map[string]any{"status": "2fa_required", "pre_auth_token": "pre-auth", "next": "/settings"}
	if status != http.StatusOK || !jsonEqual(out, want) {
		t.Fatalf("%d %v, want 200 %v", status, out, want)
	}
}

func TestHandoffUnknownCode(t *testing.T) {
	api := newHandoffAPI(t, config.IdentityConfig{}, &memHandoff{m: map[string]SignInResponse{}})
	if status, out := redeemHandoff(t, api, "never-issued"); status != http.StatusUnauthorized || out["code"] != string(CodeInvalidToken) {
		t.Fatalf("%d %v, want 401 invalid_token", status, out)
	}
	if resp := api.Post(AuthPrefix+"/handoff", map[string]any{"code": ""}); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("empty code: %d, want 422", resp.Code)
	}
	if resp := api.Post(AuthPrefix+"/handoff", map[string]any{}); resp.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing code: %d, want 422", resp.Code)
	}
}

func TestHandoffStoreError(t *testing.T) {
	for _, err := range []error{ErrHandoffUnavailable, errors.New("valkey down")} {
		api := newHandoffAPI(t, config.IdentityConfig{}, failingHandoff{err: err})
		if status, out := redeemHandoff(t, api, "code"); status != http.StatusInternalServerError || out["code"] != string(CodeInternal) {
			t.Errorf("%v: %d %v, want 500 internal_error", err, status, out)
		}
	}
}

func TestHandoffRateLimiterUnavailable(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	limiter, _ := ratelimit.New(nil, logger, nil) // no Valkey: fails closed
	cfg := config.IdentityConfig{}
	cfg.RateLimits.HandoffPerIP = config.RateLimit{Limit: 5, Window: time.Minute}
	store := &memHandoff{m: map[string]SignInResponse{}}
	code, _ := store.Issue(context.Background(), NewSignInTwoFactor("pre-auth", ""), HandoffTTL)
	_, api := humatest.New(t)
	NewHandoff(cfg, store, limiter, logger).Register(api)
	resp := api.Post(AuthPrefix+"/handoff", map[string]any{"code": code})
	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.Code)
	}
	if _, ok := store.m[code]; !ok {
		t.Error("a refused request consumed the code")
	}
}
