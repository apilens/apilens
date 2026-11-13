//go:build integration

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/testutil"
)

// keysFixture is the project fixture with the API key endpoints mounted and
// an edge-style verifier subscribed to the Valkey invalidation channel, as
// the edge role runs it.
type keysFixture struct {
	*orgsFixture
	verifier *apikeys.Verifier
}

// keyCacheTTL is the verifier's cache cycle in these tests: long enough that
// only the invalidation, not expiry, can make a revoked key fail.
const keyCacheTTL = time.Minute

func setupKeys(t *testing.T) *keysFixture {
	t.Helper()
	return setupKeysWith(t, 0)
}

// setupKeysWith is setupKeys with ingest.max_keys_per_project = maxKeys (0:
// no cap).
func setupKeysWith(t *testing.T, maxKeys int) *keysFixture {
	t.Helper()
	f := setupProjects(t)
	logger := testutil.Logger(t)
	vcfg := testutil.Valkey(t)
	vk, err := cache.Connect(f.ctx, vcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	publish := func(ctx context.Context, hash string) error {
		return cache.Publish(ctx, vk, apikeys.InvalidateChannel, hash)
	}
	NewAPIKeys(apikeys.NewService(f.pool, audit.New(f.pool), publish, logger).WithMaxKeys(maxKeys), logger).Register(f.api)

	// The edge: its own verifier and its own subscription.
	v := apikeys.NewVerifier(db.New(f.pool), apikeys.Options{Size: 100, TTL: keyCacheTTL, NegativeTTL: keyCacheTTL}, logger, nil)
	sub, err := cache.Connect(f.ctx, vcfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sub.Close)
	ctx, cancel := context.WithCancel(f.ctx)
	t.Cleanup(cancel)
	go cache.Subscribe(ctx, sub, logger, apikeys.InvalidateChannel, v.Invalidate)
	time.Sleep(200 * time.Millisecond) // let SUBSCRIBE land
	return &keysFixture{orgsFixture: f, verifier: v}
}

func (f *keysFixture) createKey(user uuid.UUID, project string, body map[string]any) *httptest.ResponseRecorder {
	return f.api.Post(ProjectsPath+"/"+project+"/api-keys", as(user), body)
}

func (f *keysFixture) mustCreateKey(t *testing.T, user uuid.UUID, project, name string, scopes ...string) CreatedAPIKey {
	t.Helper()
	resp := f.createKey(user, project, map[string]any{"name": name, "scopes": scopes})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create key %s: %d %s", name, resp.Code, resp.Body)
	}
	return decode[CreatedAPIKey](t, resp)
}

func (f *keysFixture) listKeys(t *testing.T, user uuid.UUID, project string) []APIKey {
	t.Helper()
	resp := f.api.Get(ProjectsPath+"/"+project+"/api-keys", as(user))
	if resp.Code != http.StatusOK {
		t.Fatalf("list keys: %d %s", resp.Code, resp.Body)
	}
	return decode[[]APIKey](t, resp)
}

func (f *keysFixture) revokeKey(user uuid.UUID, project, id string) *httptest.ResponseRecorder {
	return f.api.Delete(ProjectsPath+"/"+project+"/api-keys/"+id, as(user))
}

func TestCreateAndListAPIKeys(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "k-owner@example.com")
	member := f.user(t, "k-member@example.com")
	viewer := f.user(t, "k-viewer@example.com")
	stranger := f.user(t, "k-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.join(t, "acme", viewer, "viewer")
	p := f.mustCreateProject(t, owner, "acme", "Shop", "shop")

	expires := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	resp := f.createKey(member, "shop", map[string]any{"name": "  CI ingest ", "scopes": []string{"read", "ingest"}, "expires_at": expires})
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	c := decode[CreatedAPIKey](t, resp)
	if !strings.HasPrefix(c.Key, apikeys.Prefix) || c.Prefix != c.Key[:apikeys.DisplayPrefixLen] || c.Name != "CI ingest" ||
		!slices.Equal(c.Scopes, []string{"ingest", "apps:create", "read"}) || c.ExpiresAt == nil || !c.ExpiresAt.Equal(expires) ||
		c.RevokedAt != nil || c.LastUsedAt != nil || c.CreatedAt.IsZero() {
		t.Fatalf("created = %+v", c)
	}
	// Only the hash is stored.
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE key_hash = $1 AND project_id = $2`, apikeys.Hash(c.Key), p.ID); n != 1 {
		t.Fatalf("stored keys = %d", n)
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys WHERE key_hash = $1 OR prefix = $1`, c.Key); n != 0 {
		t.Fatal("raw key stored")
	}

	// The new key works on the edge.
	pr, err := f.verifier.Verify(f.ctx, c.Key)
	if err != nil || pr.ProjectID.String() != p.ID || !pr.HasScope("read") || !pr.HasScope("ingest") {
		t.Fatalf("verify = %+v, %v", pr, err)
	}

	// Audit: api_key.created by the member, without the key.
	var actor uuid.UUID
	var meta map[string]any
	var raw string
	if err := f.pool.QueryRow(f.ctx, `SELECT actor_user_id, metadata, metadata::text FROM audit_events WHERE event = 'api_key.created'`).Scan(&actor, &meta, &raw); err != nil {
		t.Fatal(err)
	}
	if actor != member || meta["key_id"] != c.ID || meta["project_id"] != p.ID || meta["prefix"] != c.Prefix || meta["name"] != "CI ingest" {
		t.Fatalf("audit = %s %v", actor, meta)
	}
	if strings.Contains(raw, c.Key) || strings.Contains(raw, apikeys.Hash(c.Key)) {
		t.Fatalf("audit metadata leaks the key: %s", raw)
	}

	second := f.mustCreateKey(t, owner, "shop", "Prod", "ingest")

	// List: newest first, no raw key, every member (viewers too) may read.
	for _, u := range []uuid.UUID{owner, viewer} {
		list := f.listKeys(t, u, "shop")
		if len(list) != 2 || list[0].ID != second.ID || list[1].ID != c.ID || list[1].Name != "CI ingest" ||
			!slices.Equal(list[0].Scopes, []string{"ingest", "apps:create"}) || list[0].ExpiresAt != nil {
			t.Fatalf("list = %+v", list)
		}
	}
	listBody := f.api.Get(ProjectsPath+"/shop/api-keys", as(owner)).Body.String()
	if strings.Contains(listBody, c.Key) || strings.Contains(listBody, second.Key) {
		t.Fatal("list leaks a raw key")
	}
	var fields []map[string]any
	if err := json.Unmarshal([]byte(listBody), &fields); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"id", "name", "prefix", "scopes", "created_at", "expires_at", "last_used_at", "revoked_at"} {
		if _, ok := fields[0][k]; !ok {
			t.Errorf("list item has no %q: %v", k, fields[0])
		}
	}
	if _, ok := fields[0]["key"]; ok {
		t.Error("list item has the raw key")
	}

	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		slug   string
		body   map[string]any
		status int
		code   string
	}{
		{"viewer", viewer, "shop", map[string]any{"name": "x", "scopes": []string{"ingest"}}, http.StatusForbidden, "forbidden"},
		{"stranger", stranger, "shop", map[string]any{"name": "x", "scopes": []string{"ingest"}}, http.StatusForbidden, "forbidden"},
		{"missing project", owner, "missing", map[string]any{"name": "x", "scopes": []string{"ingest"}}, http.StatusForbidden, "forbidden"},
		{"blank name", owner, "shop", map[string]any{"name": "   ", "scopes": []string{"ingest"}}, http.StatusBadRequest, "invalid_request"},
		{"past expiry", owner, "shop", map[string]any{"name": "x", "scopes": []string{"ingest"}, "expires_at": time.Now().Add(-time.Hour)}, http.StatusBadRequest, "invalid_request"},
	} {
		resp := f.createKey(tc.user, tc.slug, tc.body)
		if pb := decode[problem](t, resp); resp.Code != tc.status || pb.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	for _, body := range []map[string]any{
		{"name": "x", "scopes": []string{"admin"}},
		{"name": "x", "scopes": []string{}},
		{"name": "x"},
	} {
		if resp := f.createKey(owner, "shop", body); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("create %v: %d %s", body, resp.Code, resp.Body)
		}
	}
	if resp := f.api.Get(ProjectsPath+"/shop/api-keys", as(stranger)); resp.Code != http.StatusForbidden {
		t.Errorf("stranger list: %d %s", resp.Code, resp.Body)
	}
	if n := f.count(t, `SELECT count(*) FROM api_keys`); n != 2 {
		t.Fatalf("keys = %d, want 2", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'api_key.created'`); n != 2 {
		t.Fatalf("api_key.created events = %d, want 2", n)
	}
}

// A revoked key is rejected by the edge verifier well within one cache cycle:
// the revocation publishes the key hash on the Valkey channel the edge
// subscribes to.
func TestRevokeAPIKeyInvalidatesEdgeCache(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "r-owner@example.com")
	viewer := f.user(t, "r-viewer@example.com")
	other := f.user(t, "r-other@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", viewer, "viewer")
	f.mustCreate(t, other, "Other", "other")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	f.mustCreateProject(t, other, "other", "Elsewhere", "elsewhere")
	k := f.mustCreateKey(t, owner, "shop", "Ingest", "ingest")
	keep := f.mustCreateKey(t, owner, "shop", "Keep", "ingest")
	foreign := f.mustCreateKey(t, other, "elsewhere", "Foreign", "ingest")

	// Warm the edge cache.
	if _, err := f.verifier.Verify(f.ctx, k.Key); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name   string
		user   uuid.UUID
		slug   string
		id     string
		status int
		code   string
	}{
		{"viewer", viewer, "shop", k.ID, http.StatusForbidden, "forbidden"},
		{"stranger", other, "shop", k.ID, http.StatusForbidden, "forbidden"},
		{"key of another project", owner, "shop", foreign.ID, http.StatusGone, "api_key_gone"},
		{"unknown key", owner, "shop", uuid.NewString(), http.StatusGone, "api_key_gone"},
	} {
		resp := f.revokeKey(tc.user, tc.slug, tc.id)
		if pb := decode[problem](t, resp); resp.Code != tc.status || pb.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if _, err := f.verifier.Verify(f.ctx, foreign.Key); err != nil {
		t.Fatalf("foreign key revoked: %v", err)
	}

	start := time.Now()
	if resp := f.revokeKey(owner, "shop", k.ID); resp.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", resp.Code, resp.Body)
	}
	for {
		_, err := f.verifier.Verify(f.ctx, k.Key)
		if errors.Is(err, apikeys.ErrInvalidKey) {
			break
		}
		if time.Since(start) > 5*time.Second {
			t.Fatalf("revoked key still accepted by the edge: %v", err)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if time.Since(start) >= keyCacheTTL {
		t.Fatal("revocation took a full cache cycle")
	}
	if _, err := f.verifier.Verify(f.ctx, keep.Key); err != nil {
		t.Fatalf("other key: %v", err)
	}

	for _, item := range f.listKeys(t, owner, "shop") {
		if (item.ID == k.ID) != (item.RevokedAt != nil) {
			t.Fatalf("list after revoke: %+v", item)
		}
	}

	// Revoking again changes nothing and audits nothing.
	if resp := f.revokeKey(owner, "shop", k.ID); resp.Code != http.StatusNoContent {
		t.Fatalf("revoke again: %d %s", resp.Code, resp.Body)
	}
	var actor uuid.UUID
	var meta map[string]any
	if err := f.pool.QueryRow(f.ctx, `SELECT actor_user_id, metadata FROM audit_events WHERE event = 'api_key.revoked'`).Scan(&actor, &meta); err != nil {
		t.Fatal(err)
	}
	if actor != owner || meta["key_id"] != k.ID || meta["project_slug"] != "shop" {
		t.Fatalf("audit = %s %v", actor, meta)
	}
}
