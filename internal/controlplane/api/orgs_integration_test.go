//go:build integration

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/identity/audit"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// testUserHeader names the user a request runs as. Session verification is
// covered by authn's own tests; here the principal is injected directly.
const testUserHeader = "X-Test-User"

type orgsFixture struct {
	api  humatest.TestAPI
	pool *pgxpool.Pool
	ctx  context.Context
}

func setupOrgs(t *testing.T, slugCheck ratelimit.Rate) *orgsFixture {
	t.Helper()
	pool := testutil.MigratedPostgres(t)
	client, err := cache.Connect(context.Background(), testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	logger := testutil.Logger(t)
	limiter, err := ratelimit.New(client, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		id, err := uuid.Parse(ctx.Header(testUserHeader))
		if err != nil {
			next(ctx)
			return
		}
		c := authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: id})
		c = audit.WithRequest(c, audit.Request{IP: netip.MustParseAddr("203.0.113.7"), UserAgent: "itest"})
		next(huma.WithContext(ctx, c))
	})
	NewOrgs(orgs.New(pool, audit.New(pool)), limiter, slugCheck, logger).Register(api)
	return &orgsFixture{api: api, pool: pool, ctx: context.Background()}
}

func (f *orgsFixture) user(t *testing.T, email string) uuid.UUID {
	t.Helper()
	now := time.Now()
	u, err := identitydb.New(f.pool).CreateUser(f.ctx, identitydb.CreateUserParams{ID: uuid.New(), Email: email, EmailVerifiedAt: &now, Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func as(user uuid.UUID) string { return testUserHeader + ": " + user.String() }

func (f *orgsFixture) create(user uuid.UUID, name, slug string) *httptest.ResponseRecorder {
	return f.api.Post(OrgsPath, as(user), map[string]any{"name": name, "slug": slug})
}

type problem struct {
	Status      int      `json:"status"`
	Code        string   `json:"code"`
	Suggestions []string `json:"suggestions"`
}

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

func (f *orgsFixture) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(f.ctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// checkSuggestions requires 1..3 distinct, valid, unreserved and free slugs.
func (f *orgsFixture) checkSuggestions(t *testing.T, got []string) {
	t.Helper()
	if len(got) == 0 || len(got) > orgs.MaxSuggestions {
		t.Fatalf("suggestions = %v, want 1..%d", got, orgs.MaxSuggestions)
	}
	for i, s := range got {
		if !orgs.ValidSlug(s) || orgs.Reserved(s) || slices.Contains(got[:i], s) {
			t.Fatalf("bad suggestion %q in %v", s, got)
		}
		if n := f.count(t, `SELECT count(*) FROM organizations WHERE slug = $1 AND deleted_at IS NULL`, s); n != 0 {
			t.Fatalf("suggestion %q is taken", s)
		}
	}
}

func TestCreateOrg(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "owner@example.com")

	resp := f.create(owner, "  Acme Inc  ", "acme")
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	org := decode[Org](t, resp)
	if org.Slug != "acme" || org.Name != "Acme Inc" || org.Role != "owner" || org.CreatedAt.IsZero() {
		t.Fatalf("org = %+v", org)
	}
	id := uuid.MustParse(org.ID)

	var createdBy uuid.UUID
	if err := f.pool.QueryRow(f.ctx, `SELECT created_by FROM organizations WHERE id = $1`, id).Scan(&createdBy); err != nil || createdBy != owner {
		t.Fatalf("created_by = %v (%v), want %v", createdBy, err, owner)
	}
	if n := f.count(t, `SELECT count(*) FROM memberships WHERE org_id = $1 AND user_id = $2 AND role = 'owner'`, id, owner); n != 1 {
		t.Fatalf("owner memberships = %d, want 1", n)
	}

	var topic, aggregate string
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT topic, aggregate_id, payload FROM outbox`).Scan(&topic, &aggregate, &payload); err != nil {
		t.Fatal(err)
	}
	if topic != "org.created" || aggregate != id.String() || payload["org_id"] != id.String() || payload["owner_user_id"] != owner.String() {
		t.Fatalf("outbox = %s %s %v", topic, aggregate, payload)
	}

	evs, err := identitydb.New(f.pool).ListAuditEventsForUser(f.ctx, identitydb.ListAuditEventsForUserParams{UserID: owner, PageSize: 10})
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, e := range evs {
		if e.Event != string(audit.OrgCreated) {
			continue
		}
		found = true
		var meta map[string]string
		if err := json.Unmarshal(e.Metadata, &meta); err != nil {
			t.Fatal(err)
		}
		if meta["org_id"] != id.String() || meta["slug"] != "acme" || e.ActorUserID == nil || *e.ActorUserID != owner {
			t.Fatalf("audit event = %+v meta %v", e, meta)
		}
		if e.Ip == nil || e.Ip.String() != "203.0.113.7" || e.UserAgent != "itest" {
			t.Fatalf("audit request = %v %q", e.Ip, e.UserAgent)
		}
	}
	if !found {
		t.Fatal("no org.created audit event")
	}

	t.Run("taken slug answers slug_taken with free suggestions", func(t *testing.T) {
		other := f.user(t, "other@example.com")
		// acme-2 is taken too, so it must not be suggested.
		if resp := f.create(other, "Acme Two", "acme-2"); resp.Code != http.StatusCreated {
			t.Fatalf("acme-2: %d %s", resp.Code, resp.Body)
		}
		resp := f.create(other, "Acme Again", "acme")
		if resp.Code != http.StatusConflict {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		p := decode[problem](t, resp)
		if p.Code != "slug_taken" {
			t.Fatalf("code = %q", p.Code)
		}
		f.checkSuggestions(t, p.Suggestions)
		if slices.Contains(p.Suggestions, "acme-2") || p.Suggestions[0] != "acme-3" {
			t.Fatalf("suggestions = %v", p.Suggestions)
		}
		if n := f.count(t, `SELECT count(*) FROM memberships WHERE user_id = $1`, other); n != 1 {
			t.Fatalf("failed create left memberships: %d", n)
		}
	})

	t.Run("reserved slug answers slug_taken", func(t *testing.T) {
		resp := f.create(owner, "Admin", "admin")
		if p := decode[problem](t, resp); resp.Code != http.StatusConflict || p.Code != "slug_taken" {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		} else {
			f.checkSuggestions(t, p.Suggestions)
		}
	})

	t.Run("invalid input", func(t *testing.T) {
		for _, body := range []map[string]any{
			{"name": "X", "slug": "Acme"},
			{"name": "X", "slug": "-acme"},
			{"name": "X", "slug": ""},
			{"name": "", "slug": "fine"},
		} {
			if resp := f.api.Post(OrgsPath, as(owner), body); resp.Code != http.StatusUnprocessableEntity {
				t.Errorf("%v: status = %d, want 422", body, resp.Code)
			}
		}
		resp := f.create(owner, "   ", "blank-name")
		if p := decode[problem](t, resp); resp.Code != http.StatusBadRequest || p.Code != "invalid_request" {
			t.Fatalf("blank name: %d %s", resp.Code, resp.Body)
		}
	})

	t.Run("user gone answers session_expired", func(t *testing.T) {
		resp := f.create(uuid.New(), "Ghost", "ghost")
		if p := decode[problem](t, resp); resp.Code != http.StatusUnauthorized || p.Code != "session_expired" {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
	})

	t.Run("unauthenticated", func(t *testing.T) {
		if resp := f.api.Post(OrgsPath, map[string]any{"name": "X", "slug": "anon"}); resp.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", resp.Code)
		}
	})
}

// Concurrent creates of one slug: exactly one wins, the rest get slug_taken,
// and nothing of the losers survives.
func TestCreateOrgRace(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	const n = 8
	users := make([]uuid.UUID, n)
	for i := range users {
		users[i] = f.user(t, "racer"+strconv.Itoa(i)+"@example.com")
	}
	codes := make([]int, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			resp := f.create(users[i], "Race", "race")
			codes[i] = resp.Code
			if resp.Code == http.StatusConflict {
				if p := decode[problem](t, resp); p.Code != "slug_taken" || len(p.Suggestions) == 0 {
					t.Errorf("loser problem = %+v", p)
				}
			}
		}()
	}
	close(start)
	wg.Wait()

	var won, lost int
	for _, c := range codes {
		switch c {
		case http.StatusCreated:
			won++
		case http.StatusConflict:
			lost++
		default:
			t.Errorf("unexpected status %d", c)
		}
	}
	if won != 1 || lost != n-1 {
		t.Fatalf("won %d, lost %d (codes %v)", won, lost, codes)
	}
	if c := f.count(t, `SELECT count(*) FROM organizations WHERE slug = 'race'`); c != 1 {
		t.Fatalf("organizations = %d", c)
	}
	if c := f.count(t, `SELECT count(*) FROM memberships`); c != 1 {
		t.Fatalf("memberships = %d", c)
	}
	if c := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'org.created'`); c != 1 {
		t.Fatalf("outbox rows = %d", c)
	}
	if c := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'org.created'`); c != 1 {
		t.Fatalf("audit events = %d", c)
	}
}

type availability struct {
	Available   bool     `json:"available"`
	Suggestions []string `json:"suggestions"`
}

func TestSlugAvailable(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{Limit: 5, Window: time.Minute})
	user := f.user(t, "checker@example.com")
	if resp := f.create(user, "Taken", "taken"); resp.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.Code, resp.Body)
	}
	check := func(u uuid.UUID, slug string) *httptest.ResponseRecorder {
		return f.api.Get(SlugAvailablePath+"?slug="+slug, as(u))
	}

	resp := check(user, "free")
	a := decode[availability](t, resp)
	if resp.Code != http.StatusOK || !a.Available || a.Suggestions == nil || len(a.Suggestions) != 0 {
		t.Fatalf("free: %d %s", resp.Code, resp.Body)
	}
	if body := strings.TrimSpace(resp.Body.String()); body != `{"available":true,"suggestions":[]}` {
		t.Fatalf("free body = %s", resp.Body)
	}

	for _, slug := range []string{"taken", "apilens"} {
		resp := check(user, slug)
		a := decode[availability](t, resp)
		if resp.Code != http.StatusOK || a.Available {
			t.Fatalf("%s: %d %s", slug, resp.Code, resp.Body)
		}
		f.checkSuggestions(t, a.Suggestions)
	}

	if resp := check(user, "Bad_Slug"); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid slug: status = %d", resp.Code)
	}

	// Five checks in the window so far (one rejected by validation still
	// counts); the next is limited, with Retry-After.
	resp = check(user, "free")
	if resp.Code != http.StatusOK {
		t.Fatalf("5th check: %d %s", resp.Code, resp.Body)
	}
	resp = check(user, "free")
	if resp.Code != http.StatusTooManyRequests || resp.Header().Get("Retry-After") == "" {
		t.Fatalf("6th check: %d %v", resp.Code, resp.Header())
	}
	// The limit is per user.
	other := f.user(t, "other-checker@example.com")
	if resp := check(other, "free"); resp.Code != http.StatusOK {
		t.Fatalf("other user: %d %s", resp.Code, resp.Body)
	}

	if resp := f.api.Get(SlugAvailablePath + "?slug=free"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: %d", resp.Code)
	}
}
