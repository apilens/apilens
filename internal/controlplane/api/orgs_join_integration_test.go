//go:build integration

package api

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	identitydb "github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// namedUser creates a user with a verified email and name.
func (f *orgsFixture) namedUser(t *testing.T, email, name string) uuid.UUID {
	t.Helper()
	now := time.Now()
	u, err := identitydb.New(f.pool).CreateUser(f.ctx, identitydb.CreateUserParams{ID: uuid.New(), Email: email, EmailVerifiedAt: &now, Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

// domains sets the allowed domains and domain join of the organization slug.
func (f *orgsFixture) domains(t *testing.T, slug string, join bool, domains ...string) {
	t.Helper()
	if domains == nil {
		domains = []string{}
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE organizations SET allowed_domains = $2, domain_join = $3 WHERE slug = $1 AND deleted_at IS NULL`, slug, domains, join); err != nil {
		t.Fatal(err)
	}
}

func TestJoinableOrgs(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.namedUser(t, "grace@acme.com", "Grace Hopper")
	admin := f.namedUser(t, "ada@acme.com", "Ada Lovelace")
	early := f.namedUser(t, "bob@acme.com", "")
	late := f.namedUser(t, "zed@acme.com", "Zed")
	acme := f.mustCreate(t, owner, "Acme", "acme")
	f.join(t, "acme", admin, "admin")
	f.join(t, "acme", early, "member")
	f.join(t, "acme", late, "viewer")
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, 'web', 'Web')`, uuid.New(), uuid.MustParse(acme.ID)); err != nil {
		t.Fatal(err)
	}
	f.domains(t, "acme", true, "acme.com", "acme.io")
	f.mustCreate(t, owner, "Acme Labs", "acme-labs")
	f.domains(t, "acme-labs", true, "acme.com")
	f.mustCreate(t, owner, "Closed", "closed") // domain join off
	f.domains(t, "closed", false, "acme.com")
	f.mustCreate(t, owner, "Globex", "globex")
	f.domains(t, "globex", true, "globex.com")
	f.mustCreate(t, owner, "Gone", "gone")
	f.domains(t, "gone", true, "acme.com")
	if _, err := f.pool.Exec(f.ctx, `UPDATE organizations SET deleted_at = now() WHERE slug = 'gone'`); err != nil {
		t.Fatal(err)
	}

	joiner := f.namedUser(t, "Newbie@ACME.com", "Newbie")
	resp := f.api.Get(JoinableOrgsPath, as(joiner))
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	list := decode[[]JoinableOrg](t, resp)
	if len(list) != 2 || list[0].Slug != "acme" || list[1].Slug != "acme-labs" {
		t.Fatalf("joinable = %+v", list)
	}
	if a := list[0]; a.ID != acme.ID || a.Name != "Acme" || a.MemberCount != 4 || a.ProjectCount != 1 ||
		!slices.Equal(a.MemberInitials, []string{"GH", "AL", "B"}) {
		t.Fatalf("acme = %+v", a)
	}
	if b := list[1]; b.MemberCount != 1 || b.ProjectCount != 0 || !slices.Equal(b.MemberInitials, []string{"GH"}) {
		t.Fatalf("acme-labs = %+v", b)
	}
	if strings.Contains(resp.Body.String(), "@") {
		t.Fatalf("joinable leaks member emails: %s", resp.Body)
	}

	// Members do not see their own organizations.
	if list := decode[[]JoinableOrg](t, f.api.Get(JoinableOrgsPath, as(admin))); len(list) != 1 || list[0].Slug != "acme-labs" {
		t.Fatalf("admin joinable = %+v", list)
	}

	// No match: another domain, an unverified email, a public email domain
	// even when an organization lists it.
	unverified, err := identitydb.New(f.pool).CreateUser(f.ctx, identitydb.CreateUserParams{ID: uuid.New(), Email: "unverified@acme.com", Name: "U"})
	if err != nil {
		t.Fatal(err)
	}
	gmail := f.namedUser(t, "someone@gmail.com", "Someone")
	if _, err := f.pool.Exec(f.ctx, `UPDATE organizations SET allowed_domains = '{gmail.com}', domain_join = true WHERE slug = 'globex'`); err != nil {
		t.Fatal(err)
	}
	for _, u := range []uuid.UUID{f.namedUser(t, "x@initech.com", "X"), unverified.ID, gmail} {
		if resp := f.api.Get(JoinableOrgsPath, as(u)); resp.Code != http.StatusOK || strings.TrimSpace(resp.Body.String()) != "[]" {
			t.Fatalf("no match: %d %s", resp.Code, resp.Body)
		}
	}
}

func TestJoinOrg(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.namedUser(t, "owner@acme.com", "Owner")
	org := f.mustCreate(t, owner, "Acme", "acme")
	f.domains(t, "acme", true, "acme.com")
	f.mustCreate(t, owner, "Closed", "closed")
	f.domains(t, "closed", false, "acme.com")
	f.mustCreate(t, owner, "Globex", "globex")
	f.domains(t, "globex", true, "globex.com")
	f.mustCreate(t, owner, "Gmail Fans", "gmail-fans")
	if _, err := f.pool.Exec(f.ctx, `UPDATE organizations SET allowed_domains = '{gmail.com}', domain_join = true WHERE slug = 'gmail-fans'`); err != nil {
		t.Fatal(err)
	}
	joiner := f.namedUser(t, "joiner@acme.com", "Joiner")
	unverified, err := identitydb.New(f.pool).CreateUser(f.ctx, identitydb.CreateUserParams{ID: uuid.New(), Email: "unverified@acme.com", Name: "U"})
	if err != nil {
		t.Fatal(err)
	}
	gmail := f.namedUser(t, "someone@gmail.com", "Someone")

	// Refusals are indistinguishable from a missing organization and change
	// nothing.
	for _, tc := range []struct {
		name string
		user uuid.UUID
		slug string
	}{
		{"domain join off", joiner, "closed"},
		{"other domain", joiner, "globex"},
		{"missing", joiner, "missing"},
		{"unverified email", unverified.ID, "acme"},
		{"public email domain", gmail, "gmail-fans"},
	} {
		resp := f.api.Post(OrgsPath+"/"+tc.slug+"/join", as(tc.user))
		if resp.Code != http.StatusForbidden || decode[problem](t, resp).Code != "forbidden" {
			t.Errorf("%s: %d %s", tc.name, resp.Code, resp.Body)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM memberships WHERE user_id = ANY($1)`, []uuid.UUID{joiner, unverified.ID, gmail}); n != 0 {
		t.Fatalf("refused joins created %d memberships", n)
	}

	resp := f.api.Post(OrgsPath+"/acme/join", as(joiner))
	if resp.Code != http.StatusOK {
		t.Fatalf("join: %d %s", resp.Code, resp.Body)
	}
	if o := decode[Org](t, resp); o.ID != org.ID || o.Slug != "acme" || o.Role != "member" {
		t.Fatalf("joined = %+v", o)
	}
	if n := f.count(t, `SELECT count(*) FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.slug = 'acme' AND m.user_id = $1 AND m.role = 'member'`, joiner); n != 1 {
		t.Fatalf("memberships = %d", n)
	}
	var aggregate string
	var payload map[string]string
	if err := f.pool.QueryRow(f.ctx, `SELECT aggregate_id, payload FROM outbox WHERE topic = 'membership.upserted' AND payload->>'user_id' = $1`, joiner.String()).Scan(&aggregate, &payload); err != nil {
		t.Fatal(err)
	}
	if aggregate != org.ID || payload["org_id"] != org.ID || payload["role"] != "member" {
		t.Fatalf("outbox = %s %v", aggregate, payload)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'member.joined' AND user_id = $1 AND actor_user_id = $1 AND metadata->>'org_id' = $2 AND metadata->>'domain' = 'acme.com'`, joiner, org.ID); n != 1 {
		t.Fatalf("member.joined audit events = %d", n)
	}

	// Joining again, or as an existing owner, changes nothing.
	for _, u := range []uuid.UUID{joiner, owner} {
		resp := f.api.Post(OrgsPath+"/acme/join", as(u))
		if resp.Code != http.StatusOK {
			t.Fatalf("rejoin: %d %s", resp.Code, resp.Body)
		}
		want := "member"
		if u == owner {
			want = "owner"
		}
		if o := decode[Org](t, resp); o.Role != want {
			t.Fatalf("rejoin role = %s, want %s", o.Role, want)
		}
	}
	if n := f.count(t, `SELECT count(*) FROM outbox WHERE topic = 'membership.upserted'`); n != 1 {
		t.Fatalf("membership.upserted rows = %d, want 1", n)
	}
	if n := f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'member.joined'`); n != 1 {
		t.Fatalf("member.joined audit events = %d, want 1", n)
	}

	// The joined organization is now the joiner's and no longer joinable.
	if list := decode[[]OrgSummary](t, f.api.Get(OrgsPath, as(joiner))); len(list) != 1 || list[0].Slug != "acme" || list[0].Role != "member" {
		t.Fatalf("joiner orgs = %+v", list)
	}
	if list := decode[[]JoinableOrg](t, f.api.Get(JoinableOrgsPath, as(joiner))); len(list) != 0 {
		t.Fatalf("joinable after join = %+v", list)
	}
}
