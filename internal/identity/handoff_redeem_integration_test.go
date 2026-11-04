//go:build integration

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestHandoffIntegration runs POST /auth/handoff against Valkey (handoff
// codes, per-IP limit).
func TestHandoffIntegration(t *testing.T) {
	ctx := context.Background()
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
	store := NewValkeyHandoffStore(vk)

	cfg := config.IdentityConfig{}
	cfg.RateLimits.HandoffPerIP = config.RateLimit{Limit: 8, Window: time.Minute}
	_, api := humatest.New(t)
	NewHandoff(cfg, store, limiter, logger).Register(api)
	redeem := func(code string) (int, SignInResponse, string) {
		t.Helper()
		resp := api.Post(AuthPrefix+"/handoff", map[string]any{"code": code})
		var out SignInResponse
		var problem Problem
		if resp.Code == http.StatusOK {
			if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
		} else {
			_ = json.Unmarshal(resp.Body.Bytes(), &problem)
		}
		return resp.Code, out, string(problem.Code)
	}

	// A session bundle redeems once; the second exchange fails.
	bundle := SignInResponse{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresIn:    900,
		User:         &AuthUser{ID: "0193e5d2-0000-7000-8000-000000000001", Email: "ada@example.com", EmailVerified: true},
		Next:         "/projects",
	}
	code, err := store.Issue(ctx, bundle, HandoffTTL)
	if err != nil {
		t.Fatal(err)
	}
	status, got, _ := redeem(code)
	if status != http.StatusOK || got.AccessToken != "access" || got.RefreshToken != "refresh" ||
		got.ExpiresIn != 900 || got.Next != "/projects" || got.User == nil || *got.User != *bundle.User {
		t.Fatalf("first exchange: %d %+v", status, got)
	}
	if n, err := vk.Do(ctx, vk.B().Exists().Key(HandoffKey(code)).Build()).AsInt64(); err != nil || n != 0 {
		t.Fatalf("code still stored after redemption: %d (%v)", n, err)
	}
	if status, _, errCode := redeem(code); status != http.StatusUnauthorized || errCode != string(CodeInvalidToken) {
		t.Fatalf("second exchange: %d %s, want 401 invalid_token", status, errCode)
	}

	// The 2fa_required answer is handed off the same way.
	code, err = store.Issue(ctx, NewSignInTwoFactor("pre-auth", "/settings"), HandoffTTL)
	if err != nil {
		t.Fatal(err)
	}
	if status, got, _ := redeem(code); status != http.StatusOK || got.Status != TwoFactorRequiredStatus ||
		got.PreAuthToken != "pre-auth" || got.AccessToken != "" || got.Next != "/settings" {
		t.Fatalf("2fa exchange: %d %+v", status, got)
	}

	// An unknown code is refused.
	if status, _, errCode := redeem("never-issued"); status != http.StatusUnauthorized || errCode != string(CodeInvalidToken) {
		t.Fatalf("unknown code: %d %s, want 401 invalid_token", status, errCode)
	}

	// Racing redemptions of one code: exactly one wins (GETDEL).
	code, err = store.Issue(ctx, bundle, HandoffTTL)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make([]int, 2)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], _, _ = redeem(code)
		}()
	}
	wg.Wait()
	if ok := (results[0] == http.StatusOK) != (results[1] == http.StatusOK); !ok {
		t.Fatalf("racing exchanges: %v, want exactly one 200", results)
	}

	// 8 per minute per IP: 6 requests so far, so the 7th and 8th pass and
	// the 9th is limited.
	for i := 7; i <= 8; i++ {
		if status, _, _ := redeem("never-issued"); status != http.StatusUnauthorized {
			t.Fatalf("request %d: %d, want 401", i, status)
		}
	}
	code, err = store.Issue(ctx, bundle, HandoffTTL)
	if err != nil {
		t.Fatal(err)
	}
	resp := api.Post(AuthPrefix+"/handoff", map[string]any{"code": code})
	if resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") == "" {
		t.Fatalf("9th request: %d (Retry-After %q), want 429 with Retry-After", resp.Code, resp.Header().Get("Retry-After"))
	}
	// A limited request does not burn the code.
	if n, err := vk.Do(ctx, vk.B().Exists().Key(HandoffKey(code)).Build()).AsInt64(); err != nil || n != 1 {
		t.Fatalf("limited request consumed the code: exists = %d (%v)", n, err)
	}
}
