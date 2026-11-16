//go:build integration

package api

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
)

// TestAPIKeyLimitPerProject: a project holds at most
// ingest.max_keys_per_project active keys. Revoked and expired keys do not
// count, and other projects have their own budget.
func TestAPIKeyLimitPerProject(t *testing.T) {
	f := setupKeysWith(t, 2)
	owner := f.user(t, "kl-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	f.mustCreateProject(t, owner, "acme", "Checkout", "checkout")

	first := f.mustCreateKey(t, owner, "shop", "one", "ingest")
	f.mustCreateKey(t, owner, "shop", "two", "ingest")
	resp := f.createKey(owner, "shop", map[string]any{"name": "three", "scopes": []string{"ingest"}})
	if resp.Code != http.StatusConflict || !strings.Contains(resp.Body.String(), `"key_limit_reached"`) {
		t.Fatalf("third key: %d %s, want 409 key_limit_reached", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE name = 'three'`); n != 0 {
		t.Fatalf("refused key stored: %d", n)
	}
	// Another project has its own budget.
	f.mustCreateKey(t, owner, "checkout", "checkout-one", "ingest")

	// Revoking one frees a slot.
	if resp := f.revokeKey(owner, "shop", first.ID); resp.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", resp.Code, resp.Body)
	}
	f.mustCreateKey(t, owner, "shop", "three", "ingest")

	// An expired key does not count either.
	if _, err := f.pool.Exec(f.ctx, `UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE name = 'three'`); err != nil {
		t.Fatal(err)
	}
	f.mustCreateKey(t, owner, "shop", "four", "ingest")
	if resp := f.createKey(owner, "shop", map[string]any{"name": "five", "scopes": []string{"ingest"}}); resp.Code != http.StatusConflict {
		t.Fatalf("over the limit again: %d %s", resp.Code, resp.Body)
	}
}

// TestAPIKeyRateLimitSetting: rate_limit_per_minute is set on create,
// listed, reaches the edge principal, kept when update-api-key-access omits
// it, replaced when it sends one and removed with 0.
func TestAPIKeyRateLimitSetting(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "rl-owner@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")

	for _, bad := range []any{0, -1, 100_000_001, "fast"} {
		resp := f.createKey(owner, "shop", map[string]any{"name": "bad", "scopes": []string{"ingest"}, "rate_limit_per_minute": bad})
		if resp.Code < 400 || resp.Code >= 500 {
			t.Errorf("rate_limit_per_minute %v: %d %s", bad, resp.Code, resp.Body)
		}
	}

	resp := f.createKey(owner, "shop", map[string]any{"name": "limited", "scopes": []string{"ingest"}, "rate_limit_per_minute": 120})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.Code, resp.Body)
	}
	c := decode[CreatedAPIKey](t, resp)
	if c.RateLimitPerMinute == nil || *c.RateLimitPerMinute != 120 {
		t.Fatalf("created rate limit = %v", c.RateLimitPerMinute)
	}
	plain := f.mustCreateKey(t, owner, "shop", "plain", "ingest")
	if plain.RateLimitPerMinute != nil {
		t.Fatalf("default rate limit = %v, want null", *plain.RateLimitPerMinute)
	}
	list := f.api.Get(ProjectsPath+"/shop/api-keys", as(owner))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"rate_limit_per_minute":null`) ||
		!strings.Contains(list.Body.String(), `"rate_limit_per_minute":120`) {
		t.Fatalf("list: %d %s", list.Code, list.Body)
	}
	pr, err := f.verifier.Verify(f.ctx, c.Key)
	if err != nil || pr.RateLimitPerMinute != 120 {
		t.Fatalf("edge principal = %+v, %v", pr, err)
	}

	access := func(body map[string]any) APIKey {
		t.Helper()
		resp := f.api.Put(ProjectsPath+"/shop/api-keys/"+c.ID+"/access", as(owner), body)
		if resp.Code != http.StatusOK {
			t.Fatalf("update access %v: %d %s", body, resp.Code, resp.Body)
		}
		return decode[APIKey](t, resp)
	}
	// Omitted: kept.
	if k := access(map[string]any{"can_create_apps": true, "app_ids": nil}); k.RateLimitPerMinute == nil || *k.RateLimitPerMinute != 120 {
		t.Fatalf("omitted rate limit not kept: %v", k.RateLimitPerMinute)
	}
	// Replaced, and the edge sees it once the cache entry is invalidated.
	if k := access(map[string]any{"can_create_apps": true, "app_ids": nil, "rate_limit_per_minute": 30}); k.RateLimitPerMinute == nil || *k.RateLimitPerMinute != 30 {
		t.Fatalf("replaced rate limit = %v", k.RateLimitPerMinute)
	}
	f.waitRateLimit(t, c.Key, 30)
	var meta map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT metadata FROM audit_events WHERE event = 'api_key.updated' ORDER BY id DESC LIMIT 1`).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	if meta["rate_limit_per_minute"] != float64(30) {
		t.Fatalf("audit metadata = %v", meta)
	}
	// 0 removes it.
	if k := access(map[string]any{"can_create_apps": true, "app_ids": nil, "rate_limit_per_minute": 0}); k.RateLimitPerMinute != nil {
		t.Fatalf("removed rate limit = %v", *k.RateLimitPerMinute)
	}
	f.waitRateLimit(t, c.Key, 0)
	bad := f.api.Put(ProjectsPath+"/shop/api-keys/"+c.ID+"/access", as(owner), map[string]any{"can_create_apps": true, "app_ids": nil, "rate_limit_per_minute": -5})
	if bad.Code < 400 || bad.Code >= 500 {
		t.Fatalf("negative rate limit: %d %s", bad.Code, bad.Body)
	}
}

// waitRateLimit waits until the edge verifier reports want as the key's
// rate limit (once the update's cache invalidation has arrived).
func (f *keysFixture) waitRateLimit(t *testing.T, raw string, want int) {
	t.Helper()
	start := time.Now()
	for {
		pr, err := f.verifier.Verify(f.ctx, raw)
		if err != nil && !errors.Is(err, apikeys.ErrInvalidKey) {
			t.Fatal(err)
		}
		if err == nil && pr.RateLimitPerMinute == want {
			return
		}
		if time.Since(start) > 5*time.Second {
			t.Fatalf("edge rate limit = %d, want %d", pr.RateLimitPerMinute, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
