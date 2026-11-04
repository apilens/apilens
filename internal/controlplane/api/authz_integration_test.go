//go:build integration

package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/platform/ratelimit"
)

// orgEndpoint is one organization operation, called by caller on the
// organization slug; target is a plain member it may act on.
type orgEndpoint struct {
	name string
	call func(f *orgsFixture, slug string, caller, target uuid.UUID) *httptest.ResponseRecorder
}

var orgEndpoints = []orgEndpoint{
	{"get-org", func(f *orgsFixture, slug string, caller, _ uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Get(orgPath(OrgPath, slug), as(caller))
	}},
	{"update-org", func(f *orgsFixture, slug string, caller, _ uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Patch(orgPath(OrgPath, slug), as(caller), map[string]any{"name": "Renamed"})
	}},
	{"delete-org", func(f *orgsFixture, slug string, caller, _ uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Delete(orgPath(OrgPath, slug), as(caller))
	}},
	{"list-org-members", func(f *orgsFixture, slug string, caller, _ uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Get(orgPath(MembersPath, slug), as(caller))
	}},
	{"change-org-member-role", func(f *orgsFixture, slug string, caller, target uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Patch(memberPath(slug, target), as(caller), map[string]any{"role": "viewer"})
	}},
	{"remove-org-member", func(f *orgsFixture, slug string, caller, target uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Delete(memberPath(slug, target), as(caller))
	}},
	{"leave-org", func(f *orgsFixture, slug string, caller, _ uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Post(orgPath(LeaveOrgPath, slug), as(caller), map[string]any{})
	}},
	{"transfer-org-ownership", func(f *orgsFixture, slug string, caller, target uuid.UUID) *httptest.ResponseRecorder {
		return f.api.Post(orgPath(TransferOwnershipPath, slug), as(caller), map[string]any{"user_id": target.String()})
	}},
}

// TestOrgEndpointsByRole runs every organization endpoint as every role,
// each on a fresh organization, with authorization answered by SpiceDB.
// A stranger (who owns another organization) always gets 404, the same as
// for a missing organization; a member lacking the permission gets 403.
func TestOrgEndpointsByRole(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	users := map[string]uuid.UUID{}
	for _, role := range []string{"owner", "admin", "member", "viewer", "stranger", "target"} {
		users[role] = f.user(t, "role-"+role+"@example.com")
	}
	f.mustCreate(t, users["stranger"], "Elsewhere", "elsewhere")

	const (
		ok      = http.StatusOK
		created = http.StatusNoContent
		deny    = http.StatusForbidden
		hide    = http.StatusNotFound
		last    = http.StatusConflict
	)
	roles := []string{"owner", "admin", "member", "viewer", "stranger"}
	want := map[string][]int{ // in the order of roles
		"get-org":                {ok, ok, ok, ok, hide},
		"update-org":             {ok, ok, deny, deny, hide},
		"delete-org":             {created, deny, deny, deny, hide},
		"list-org-members":       {ok, ok, ok, ok, hide},
		"change-org-member-role": {ok, ok, deny, deny, hide},
		"remove-org-member":      {created, created, deny, deny, hide},
		"leave-org":              {last, created, created, created, hide},
		"transfer-org-ownership": {created, deny, deny, deny, hide},
	}
	codes := map[int]string{deny: "forbidden", hide: "not_found", last: "last_owner"}

	n := 0
	for _, ep := range orgEndpoints {
		for i, role := range roles {
			n++
			slug := fmt.Sprintf("org-%d", n)
			f.mustCreate(t, users["owner"], "Org", slug)
			for _, r := range []string{"admin", "member", "viewer"} {
				f.join(t, slug, users[r], r)
			}
			f.join(t, slug, users["target"], "member")

			resp := ep.call(f, slug, users[role], users["target"])
			status := want[ep.name][i]
			if resp.Code != status {
				t.Errorf("%s as %s: %d %s, want %d", ep.name, role, resp.Code, resp.Body, status)
				continue
			}
			if code := codes[status]; code != "" && decode[problem](t, resp).Code != code {
				t.Errorf("%s as %s: %s, want code %s", ep.name, role, resp.Body, code)
			}
		}
	}
}

// An unknown slug is 404 not_found on every endpoint, for every caller, and
// looks exactly like an organization the caller cannot see.
func TestOrgEndpointsUnknownSlug(t *testing.T) {
	f := setupOrgs(t, ratelimit.Rate{})
	owner := f.user(t, "unknown-owner@example.com")
	stranger := f.user(t, "unknown-stranger@example.com")
	f.mustCreate(t, owner, "Acme", "acme")
	for _, ep := range orgEndpoints {
		for _, caller := range []uuid.UUID{owner, stranger} {
			missing := ep.call(f, "missing", caller, stranger)
			if missing.Code != http.StatusNotFound || decode[problem](t, missing).Code != "not_found" {
				t.Errorf("%s on a missing org: %d %s", ep.name, missing.Code, missing.Body)
			}
		}
		hidden := ep.call(f, "acme", stranger, owner)
		missing := ep.call(f, "missing", stranger, owner)
		if hidden.Code != missing.Code || hidden.Body.String() != missing.Body.String() {
			t.Errorf("%s: hidden %d %s vs missing %d %s", ep.name, hidden.Code, hidden.Body, missing.Code, missing.Body)
		}
	}
}
