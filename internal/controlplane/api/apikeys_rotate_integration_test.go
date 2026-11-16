//go:build integration

package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
)

func (f *keysFixture) rotateKey(user uuid.UUID, project, id, overlap string) *httptest.ResponseRecorder {
	return f.api.Post(ProjectsPath+"/"+project+"/api-keys/"+id+"/rotate", as(user), map[string]any{"overlap": overlap})
}

func (f *keysFixture) mustRotateKey(t *testing.T, user uuid.UUID, project, id, overlap string) RotatedAPIKey {
	t.Helper()
	resp := f.rotateKey(user, project, id, overlap)
	if resp.Code != http.StatusCreated {
		t.Fatalf("rotate %s (%s): %d %s", id, overlap, resp.Code, resp.Body)
	}
	return decode[RotatedAPIKey](t, resp)
}

// waitRejected waits until the edge verifier rejects raw, failing after a
// few seconds (well inside one cache cycle).
func (f *keysFixture) waitRejected(t *testing.T, raw, what string) {
	t.Helper()
	start := time.Now()
	for {
		_, err := f.verifier.Verify(f.ctx, raw)
		if errors.Is(err, apikeys.ErrInvalidKey) {
			return
		}
		if time.Since(start) > 5*time.Second {
			t.Fatalf("%s still accepted by the edge: %v", what, err)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// Rotating with an overlap: the successor copies the key's name and
// permissions, both keys ingest during the overlap, the old one is rejected
// after it, and the list links the two.
func TestRotateAPIKeyWithOverlap(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "rot-owner@example.com")
	member := f.user(t, "rot-member@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", member, "member")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")

	// A 24 h rotation of a key that expires sooner keeps that expiry, so
	// the end of the overlap can be observed here.
	soon := time.Now().Add(3 * time.Second).UTC().Truncate(time.Millisecond)
	resp := f.createKey(owner, "shop", map[string]any{
		"name": "Prod ingest", "scopes": []string{"ingest", "read"}, "expires_at": soon, "can_create_apps": false, "rate_limit_per_minute": 600,
	})
	if resp.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.Code, resp.Body)
	}
	old := decode[CreatedAPIKey](t, resp)
	if _, err := f.verifier.Verify(f.ctx, old.Key); err != nil { // warm the edge cache
		t.Fatal(err)
	}

	r := f.mustRotateKey(t, member, "shop", old.ID, "24h")
	if r.ID == old.ID || r.Key == old.Key || !strings.HasPrefix(r.Key, apikeys.Prefix) || r.Name != "Prod ingest" ||
		!slices.Equal(r.Scopes, old.Scopes) || r.CanCreateApps || r.RateLimitPerMinute == nil || *r.RateLimitPerMinute != 600 ||
		r.ExpiresAt != nil || r.RotatedFrom == nil || *r.RotatedFrom != old.ID || r.RotatedTo != nil ||
		r.CreatedBy == nil || r.CreatedBy.ID != member.String() {
		t.Fatalf("successor = %+v", r.APIKey)
	}
	if r.Previous.ID != old.ID || r.Previous.RotatedTo == nil || *r.Previous.RotatedTo != r.ID ||
		r.Previous.ExpiresAt == nil || !r.Previous.ExpiresAt.Equal(soon) {
		t.Fatalf("previous = %+v (want expires_at %s)", r.Previous, soon)
	}

	// During the overlap both keys ingest.
	for _, raw := range []string{old.Key, r.Key} {
		if _, err := f.verifier.Verify(f.ctx, raw); err != nil {
			t.Fatalf("during overlap: %v", err)
		}
	}
	// After it the old key is rejected, the new one keeps working.
	time.Sleep(time.Until(soon) + 50*time.Millisecond)
	f.waitRejected(t, old.Key, "old key after the overlap")
	if _, err := f.verifier.Verify(f.ctx, r.Key); err != nil {
		t.Fatalf("new key after overlap: %v", err)
	}

	// A 7 d rotation of a key without expiry expires the old key in 7 days.
	long := f.mustCreateKey(t, owner, "shop", "Long", "ingest")
	before := time.Now()
	r7 := f.mustRotateKey(t, owner, "shop", long.ID, "7d")
	if e := r7.Previous.ExpiresAt; e == nil || e.Before(before.Add(7*24*time.Hour-time.Minute)) || e.After(time.Now().Add(7*24*time.Hour)) {
		t.Fatalf("7d previous expires_at = %v", e)
	}

	// The list links rotated keys both ways.
	byID := map[string]APIKey{}
	for _, k := range f.listKeys(t, owner, "shop") {
		byID[k.ID] = k
	}
	if k := byID[old.ID]; k.RotatedTo == nil || *k.RotatedTo != r.ID || k.RotatedFrom != nil {
		t.Fatalf("listed old = %+v", k)
	}
	if k := byID[r.ID]; k.RotatedFrom == nil || *k.RotatedFrom != old.ID || k.RotatedTo != nil {
		t.Fatalf("listed new = %+v", k)
	}

	// Audited with both ids and no key material.
	var actor uuid.UUID
	var meta map[string]any
	var projectID, targetID string
	if err := f.pool.QueryRow(f.ctx,
		`SELECT actor_user_id, metadata, project_id::text, target_id FROM audit_events WHERE event = 'api_key.rotated' AND metadata->>'key_id' = $1`,
		old.ID).Scan(&actor, &meta, &projectID, &targetID); err != nil {
		t.Fatal(err)
	}
	if actor != member || meta["new_key_id"] != r.ID || meta["overlap"] != "24h" || targetID != old.ID || projectID == "" {
		t.Fatalf("audit = %s %v %s %s", actor, meta, projectID, targetID)
	}
	var row string
	if err := f.pool.QueryRow(f.ctx, `SELECT row_to_json(a)::text FROM audit_events a WHERE event = 'api_key.rotated' AND metadata->>'key_id' = $1`, old.ID).Scan(&row); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(row, old.Key) || strings.Contains(row, r.Key) || strings.Contains(row, apikeys.Hash(r.Key)) {
		t.Fatalf("audit row holds key material: %s", row)
	}
}

// overlap none: the old key is rejected at once (through the cache
// invalidation, well within ingest.key_cache_ttl), and keys that are not
// active cannot be rotated.
func TestRotateAPIKeyNoOverlapAndErrors(t *testing.T) {
	f := setupKeys(t)
	owner := f.user(t, "rn-owner@example.com")
	viewer := f.user(t, "rn-viewer@example.com")
	other := f.user(t, "rn-other@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", viewer, "viewer")
	f.mustCreate(t, other, "Other", "other")
	f.mustCreateProject(t, owner, "acme", "Shop", "shop")
	f.mustCreateProject(t, other, "other", "Elsewhere", "elsewhere")
	k := f.mustCreateKey(t, owner, "shop", "Ingest", "ingest")
	revoked := f.mustCreateKey(t, owner, "shop", "Revoked", "ingest")
	foreign := f.mustCreateKey(t, other, "elsewhere", "Foreign", "ingest")
	if resp := f.revokeKey(owner, "shop", revoked.ID); resp.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d %s", resp.Code, resp.Body)
	}
	if _, err := f.verifier.Verify(f.ctx, k.Key); err != nil { // warm the edge cache
		t.Fatal(err)
	}

	start := time.Now()
	r := f.mustRotateKey(t, owner, "shop", k.ID, "none")
	f.waitRejected(t, k.Key, "old key rotated without overlap")
	if time.Since(start) >= keyCacheTTL {
		t.Fatal("rotation took a full cache cycle")
	}
	if _, err := f.verifier.Verify(f.ctx, r.Key); err != nil {
		t.Fatalf("new key: %v", err)
	}

	for _, tc := range []struct {
		name    string
		user    uuid.UUID
		id      string
		overlap string
		status  int
		code    string
	}{
		{"already rotated", owner, k.ID, "24h", http.StatusConflict, "key_not_active"},
		{"revoked", owner, revoked.ID, "24h", http.StatusConflict, "key_not_active"},
		{"viewer", viewer, r.ID, "24h", http.StatusForbidden, "forbidden"},
		{"stranger", other, r.ID, "24h", http.StatusNotFound, "not_found"},
		{"key of another project", owner, foreign.ID, "24h", http.StatusGone, "api_key_gone"},
		{"unknown key", owner, uuid.NewString(), "24h", http.StatusGone, "api_key_gone"},
	} {
		resp := f.rotateKey(tc.user, "shop", tc.id, tc.overlap)
		if pb := decode[problem](t, resp); resp.Code != tc.status || pb.Code != tc.code {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if resp := f.rotateKey(owner, "shop", r.ID, "30d"); resp.Code < 400 || resp.Code >= 500 {
		t.Errorf("unknown overlap: %d %s", resp.Code, resp.Body)
	}
	// None of the refused rotations created a key.
	if n := len(f.listKeys(t, owner, "shop")); n != 3 {
		t.Fatalf("keys after refused rotations = %d, want 3", n)
	}
}
