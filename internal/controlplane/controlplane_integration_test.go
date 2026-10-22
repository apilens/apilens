//go:build integration

package controlplane_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/testutil"
)

func TestSeedVerifyRevokeAndInvalidate(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)

	opts := bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"}
	first, err := bootstrap.Seed(ctx, pool, opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := bootstrap.Seed(ctx, pool, opts)
	if err != nil {
		t.Fatal(err)
	}
	if first.ProjectID != second.ProjectID || first.AppID != second.AppID || first.APIKey == second.APIKey {
		t.Fatalf("seed should reuse resources and issue a new key: %+v vs %+v", first, second)
	}

	q := db.New(pool)
	v := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	p, err := v.Verify(ctx, first.APIKey)
	if err != nil || p.ProjectID != first.ProjectID || p.ProjectSlug != "shop" || !p.HasScope("ingest") {
		t.Fatalf("verify = %+v, %v", p, err)
	}

	apps := catalog.NewAppResolver(q, time.Minute)
	got, err := apps.Resolve(ctx, first.ProjectID, []string{"storefront", first.AppID.String()})
	if err != nil || got["storefront"] != first.AppID {
		t.Fatalf("resolve = %v, %v", got, err)
	}

	// Revoke through the store and propagate via Valkey pub/sub, exactly as
	// the control plane will in M2.
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	defer vk.Close()
	subCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go cache.Subscribe(subCtx, vk, logger, apikeys.InvalidateChannel, v.Invalidate)
	time.Sleep(200 * time.Millisecond) // let SUBSCRIBE land

	hash, err := q.RevokeAPIKey(ctx, p.KeyID)
	if err != nil {
		t.Fatal(err)
	}
	if hash != apikeys.Hash(first.APIKey) {
		t.Fatalf("revoke returned hash %q", hash)
	}
	// Still cached until the invalidation arrives.
	if _, err := v.Verify(ctx, first.APIKey); err != nil {
		t.Fatalf("expected cached principal before invalidation: %v", err)
	}
	if err := cache.Publish(ctx, vk, apikeys.InvalidateChannel, hash); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, err := v.Verify(ctx, first.APIKey)
		if errors.Is(err, apikeys.ErrInvalidKey) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("revoked key still valid after invalidation: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The other key is unaffected.
	if _, err := v.Verify(ctx, second.APIKey); err != nil {
		t.Fatalf("second key: %v", err)
	}
}
