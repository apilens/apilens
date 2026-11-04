//go:build integration

package identity

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/netip"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/audit"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/testutil"
)

const meIssuer = "https://id.example.com"

type meKeySet []idkeys.Key

func (s meKeySet) Active() (idkeys.Key, bool) { return idkeys.Active(s) }
func (s meKeySet) All() []idkeys.Key          { return s }

// soleOwner is an OwnershipChecker naming fixed users as sole owners.
type soleOwner map[uuid.UUID][]uuid.UUID

func (s soleOwner) SoleOwnedOrgs(_ context.Context, u uuid.UUID) ([]uuid.UUID, error) {
	return s[u], nil
}

type meFixture struct {
	api      humatest.TestAPI
	pool     *pgxpool.Pool
	q        *db.Queries
	sessions *session.Service
	owners   soleOwner
	ctx      context.Context
}

// setupMe serves the account endpoints over real Postgres behind the real
// session middleware, with access tokens from a real issuer.
func setupMe(t *testing.T) *meFixture {
	t.Helper()
	pool := testutil.MigratedPostgres(t)
	priv, err := rsa.GenerateKey(rand.Reader, idkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k, err := idkeys.Unstored(priv, &now, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(meKeySet{k}, token.Options{Issuer: meIssuer, TTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	logger := testutil.Logger(t)
	sessions, err := session.New(pool, issuer, session.Options{RefreshTTL: time.Hour, RefreshTTLShort: time.Hour}, logger)
	if err != nil {
		t.Fatal(err)
	}
	src := authn.KeySourceFunc(func(_ context.Context, kid string) (crypto.PublicKey, error) {
		if kid != k.KID {
			return nil, authn.ErrUnknownKey
		}
		return k.Signer().Public(), nil
	})
	owners := soleOwner{}
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(authn.Middleware(api, authn.NewSessionVerifier(src, meIssuer, nil)))
	accounts := account.New(pool, owners)
	NewAccount(accounts, logger).Register(api)
	NewOnboarding(accounts, logger).Register(api)

	ctx := audit.WithRequest(context.Background(), audit.Request{IP: netip.MustParseAddr("203.0.113.5"), UserAgent: "itest"})
	return &meFixture{api: api, pool: pool, q: db.New(pool), sessions: sessions, owners: owners, ctx: ctx}
}

// signIn creates a user and a session for it, returning the bearer header.
func (f *meFixture) signIn(t *testing.T, email string) (db.User, string) {
	t.Helper()
	verified := time.Now()
	u, err := f.q.CreateUser(f.ctx, db.CreateUserParams{ID: uuid.New(), Email: email, EmailVerifiedAt: &verified, Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	tok, err := f.sessions.Create(f.ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}
	return u, "Authorization: Bearer " + tok.AccessToken
}

func (f *meFixture) events(t *testing.T, user uuid.UUID, kind audit.Kind) []db.AuditEvent {
	t.Helper()
	evs, err := f.q.ListAuditEventsForUser(f.ctx, db.ListAuditEventsForUserParams{UserID: user, PageSize: 100})
	if err != nil {
		t.Fatal(err)
	}
	var out []db.AuditEvent
	for _, e := range evs {
		if e.Event == string(kind) {
			out = append(out, e)
		}
	}
	return out
}

func decodeMe(t *testing.T, body []byte) Me {
	t.Helper()
	var m Me
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return m
}

func TestMeGet(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "get@example.com")

	resp := f.api.Get(MePath, auth)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	m := decodeMe(t, resp.Body.Bytes())
	if m.ID != u.ID.String() || m.Email != "get@example.com" || !m.EmailVerified || m.Name != "Ada" ||
		!slices.Equal(m.AMR, []string{token.AMREmail}) || m.Preferences.Home != "" || m.CreatedAt.IsZero() {
		t.Fatalf("me = %+v", m)
	}
	var raw map[string]any
	_ = json.Unmarshal(resp.Body.Bytes(), &raw)
	for _, key := range []string{"id", "email", "email_verified", "name", "avatar_url", "preferences", "onboarding", "created_at", "amr"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("response lacks %q: %s", key, resp.Body)
		}
	}

	if resp := f.api.Get(MePath); resp.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status = %d", resp.Code)
	}
}

func TestMePatch(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "patch@example.com")
	// A key written by another flow survives the merge.
	if _, err := f.q.UpdateUserPreferences(f.ctx, db.UpdateUserPreferencesParams{ID: u.ID, Patch: []byte(`{"theme":"dark"}`)}); err != nil {
		t.Fatal(err)
	}

	resp := f.api.Patch(MePath, auth, map[string]any{
		"name":        "  Ada Lovelace ",
		"avatar_url":  "https://example.com/ada.png",
		"preferences": map[string]any{"home": "exceptions"},
	})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	m := decodeMe(t, resp.Body.Bytes())
	if m.Name != "Ada Lovelace" || m.AvatarURL != "https://example.com/ada.png" || m.Preferences.Home != "exceptions" {
		t.Fatalf("me = %+v", m)
	}
	stored, err := f.q.GetUserByID(f.ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	var prefs map[string]any
	if err := json.Unmarshal(stored.Preferences, &prefs); err != nil {
		t.Fatal(err)
	}
	if prefs["theme"] != "dark" || prefs["home"] != "exceptions" {
		t.Fatalf("stored preferences = %v", prefs)
	}

	evs := f.events(t, u.ID, audit.UserUpdated)
	if len(evs) != 1 {
		t.Fatalf("user.updated events = %d, want 1", len(evs))
	}
	var meta struct{ Fields []string }
	if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(meta.Fields, []string{"avatar_url", "name", "preferences.home"}) {
		t.Fatalf("audit fields = %v", meta.Fields)
	}
	if evs[0].ActorUserID == nil || *evs[0].ActorUserID != u.ID {
		t.Fatalf("audit actor = %v", evs[0].ActorUserID)
	}

	// Only the sent fields change.
	resp = f.api.Patch(MePath, auth, map[string]any{"preferences": map[string]any{"home": "requests"}})
	if m := decodeMe(t, resp.Body.Bytes()); resp.Code != http.StatusOK || m.Name != "Ada Lovelace" || m.Preferences.Home != "requests" {
		t.Fatalf("status = %d, me = %+v", resp.Code, m)
	}

	// last_project_slug is stored next to home.
	resp = f.api.Patch(MePath, auth, map[string]any{"preferences": map[string]any{"last_project_slug": "checkout"}})
	if m := decodeMe(t, resp.Body.Bytes()); resp.Code != http.StatusOK || m.Preferences.Home != "requests" || m.Preferences.LastProjectSlug != "checkout" {
		t.Fatalf("status = %d, me = %+v", resp.Code, m)
	}

	for name, body := range map[string]map[string]any{
		"bad last project": {"preferences": map[string]any{"last_project_slug": "-x"}},
		"bad home":         {"preferences": map[string]any{"home": "dashboard"}},
		"unknown pref":     {"preferences": map[string]any{"colour": "red"}},
		"bad avatar":       {"avatar_url": "javascript:alert(1)"},
		"unknown field":    {"email": "x@example.com"},
	} {
		if resp := f.api.Patch(MePath, auth, body); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d: %s", name, resp.Code, resp.Body)
		}
	}
	if n := len(f.events(t, u.ID, audit.UserUpdated)); n != 3 {
		t.Fatalf("user.updated events = %d, want 3", n)
	}
}

func TestMeDelete(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "delete@example.com")
	other, err := f.sessions.Create(f.ctx, u, false, session.Meta{AMR: []string{token.AMREmail}})
	if err != nil {
		t.Fatal(err)
	}

	before := time.Now()
	resp := f.api.Delete(MePath, auth)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var out struct {
		DeleteAfter time.Time `json:"delete_after"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if d := out.DeleteAfter.Sub(before); d < account.Grace-time.Minute || d > account.Grace+time.Minute {
		t.Fatalf("delete_after in %v, want ~30 days", d)
	}

	// Hidden, scheduled, and every session revoked.
	var deletedAt, deleteAfter *time.Time
	if err := f.pool.QueryRow(f.ctx, `SELECT deleted_at, delete_after FROM users WHERE id = $1`, u.ID).Scan(&deletedAt, &deleteAfter); err != nil {
		t.Fatal(err)
	}
	if deletedAt == nil || deleteAfter == nil || !deleteAfter.Equal(out.DeleteAfter) {
		t.Fatalf("deleted_at = %v, delete_after = %v", deletedAt, deleteAfter)
	}
	live, err := f.q.ListActiveSessionsForUser(f.ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 0 {
		t.Fatalf("live sessions = %d, want 0", len(live))
	}
	if _, err := f.sessions.Refresh(f.ctx, other.RefreshToken); err == nil {
		t.Fatal("refresh after delete succeeded")
	}
	evs := f.events(t, u.ID, audit.UserDeleted)
	if len(evs) != 1 {
		t.Fatalf("user.deleted events = %d, want 1", len(evs))
	}
	var meta struct {
		SessionsRevoked int `json:"sessions_revoked"`
	}
	if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil || meta.SessionsRevoked != 2 {
		t.Fatalf("audit meta = %s (%v)", evs[0].Metadata, err)
	}

	// The still-valid access token no longer reaches the account.
	if resp := f.api.Get(MePath, auth); resp.Code != http.StatusUnauthorized {
		t.Errorf("get after delete: status = %d", resp.Code)
	}
	if resp := f.api.Delete(MePath, auth); resp.Code != http.StatusUnauthorized {
		t.Errorf("delete after delete: status = %d", resp.Code)
	}
}

func TestMeDeleteSoleOwnerRefused(t *testing.T) {
	f := setupMe(t)
	u, auth := f.signIn(t, "owner@example.com")
	f.owners[u.ID] = []uuid.UUID{uuid.New()}

	resp := f.api.Delete(MePath, auth)
	if resp.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var p problemBody
	if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil || p.Code != CodeOwnerTransferRequired {
		t.Fatalf("problem = %s (%v)", resp.Body, err)
	}

	// Nothing changed.
	if _, err := f.q.GetUserByID(f.ctx, u.ID); err != nil {
		t.Fatalf("user hidden after refusal: %v", err)
	}
	live, err := f.q.ListActiveSessionsForUser(f.ctx, u.ID)
	if err != nil || len(live) != 1 {
		t.Fatalf("live sessions = %d (%v), want 1", len(live), err)
	}
	if n := len(f.events(t, u.ID, audit.UserDeleted)); n != 0 {
		t.Fatalf("user.deleted events = %d, want 0", n)
	}
}
