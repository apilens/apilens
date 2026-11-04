//go:build integration

package identity

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

func TestOAuthStartWithValkey(t *testing.T) {
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
	store := NewValkeyOAuthStateStore(client)

	cfg := testOAuthCfg
	cfg.RateLimits.OAuthStartPerIP = config.RateLimit{Limit: 3, Window: time.Minute}
	api, _ := newTestOAuth(t, cfg, store, limiter)

	resp := api.Get(startPath("github", "next=/projects&remember=true"))
	state := mustLocation(t, resp).Query().Get("state")

	ttl, err := client.Do(ctx, client.B().Ttl().Key(oauthStateKeyPrefix+state).Build()).AsInt64()
	if err != nil || ttl <= 0 || ttl > int64(OAuthStateTTL/time.Second) {
		t.Fatalf("state ttl = %d (%v), want 1..%d s", ttl, err, int64(OAuthStateTTL/time.Second))
	}
	st, err := store.Take(ctx, state)
	if err != nil {
		t.Fatal(err)
	}
	if st.Provider != "github" || st.Next != "/projects" || !st.Remember || st.Verifier == "" {
		t.Fatalf("state = %+v", st)
	}
	if _, err := store.Take(ctx, state); !errors.Is(err, ErrOAuthStateNotFound) {
		t.Fatalf("second take: err = %v, want ErrOAuthStateNotFound", err)
	}
	if err := store.Put(ctx, "dup", st, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, "dup", st, time.Minute); err == nil {
		t.Fatal("put over an existing state succeeded")
	}

	for range 2 {
		mustLocation(t, api.Get(startPath("github", "")))
	}
	resp = api.Get(startPath("github", "next="+url.QueryEscape("/x")))
	if resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") == "" {
		t.Fatalf("4th start: status = %d, Retry-After %q; want 429", resp.Code, resp.Header().Get("Retry-After"))
	}
}
