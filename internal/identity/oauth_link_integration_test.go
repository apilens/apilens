//go:build integration

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// TestOAuthLinkIntegration links, refuses a taken account and unlinks
// against Postgres (users, oauth_identities, audit_events) and Valkey
// (state), behind the real session middleware, with an httptest GitHub.
func TestOAuthLinkIntegration(t *testing.T) {
	f := setupMe(t)
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
	jobs := &fakeJobs{}
	cfg := testOAuthCfg
	cfg.PublicUIURL = testUIURL
	o := NewOAuth(cfg, NewValkeyOAuthStateStore(vk), limiter, logger).WithSignIn(OAuthSignInDeps{
		Users:      NewPGSignInUsers(f.pool),
		Audit:      audit.New(f.pool),
		Identities: NewPGOAuthIdentities(f.pool),
		Jobs:       jobs,
	})
	idp := newFakeIdP(t)
	idp.Use(o)
	o.Register(f.api)
	NewConnectedAccounts(ConnectedAccountsDeps{Identities: NewPGOAuthIdentities(f.pool), Jobs: jobs}, logger).Register(f.api)

	ada, adaAuth := f.signIn(t, "ada@example.com")
	bob, bobAuth := f.signIn(t, "bob@example.com")

	// link runs start (as auth) → GitHub account id → callback.
	link := func(t *testing.T, auth string, id int64, next string) *url.URL {
		t.Helper()
		resp := f.api.Get(startPath("github", "intent=link&next="+url.QueryEscape(next)), auth)
		state := mustLocation(t, resp).Query()
		idp.Grant(state.Get("state"), githubGrant(startedFlow{challenge: state.Get("code_challenge")}, id,
			githubEmail{Email: "octo@example.com", Primary: true, Verified: true}))
		resp = f.api.Get(callbackPath("github", url.Values{"code": {state.Get("state")}, "state": {state.Get("state")}}))
		if resp.Code != http.StatusFound {
			t.Fatalf("callback: %d %s", resp.Code, resp.Body)
		}
		loc, err := url.Parse(resp.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		return loc
	}
	list := func(t *testing.T, auth string) []ConnectedAccount {
		t.Helper()
		resp := f.api.Get(MyIdentitiesPath, auth)
		if resp.Code != http.StatusOK {
			t.Fatalf("list: %d %s", resp.Code, resp.Body)
		}
		var out struct{ Identities []ConnectedAccount }
		if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.Identities
	}
	alerts := func(change string) int {
		n := 0
		for _, j := range jobs.jobs {
			if j.Template == email.TemplateSecurityChange && j.Data["change"] == change {
				n++
			}
		}
		return n
	}

	t.Run("link needs a session", func(t *testing.T) {
		if resp := f.api.Get(startPath("github", "intent=link")); resp.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		// Sign-in stays public.
		mustLocation(t, f.api.Get(startPath("github", "")))
	})

	var linked ConnectedAccount
	t.Run("link", func(t *testing.T) {
		loc := link(t, adaAuth, 7001, "/settings/accounts")
		if loc.Path != "/settings/accounts" || loc.Query().Get("linked") != "github" {
			t.Fatalf("redirect = %s", loc)
		}
		ids := list(t, adaAuth)
		if len(ids) != 1 || ids[0].Provider != "github" || ids[0].Username != "ada" || ids[0].Email == nil || *ids[0].Email != "octo@example.com" || ids[0].LastLoginAt != nil {
			t.Fatalf("identities = %+v", ids)
		}
		linked = ids[0]
		evs := f.events(t, ada.ID, audit.OAuthLinked)
		if len(evs) != 1 {
			t.Fatalf("oauth.linked = %d", len(evs))
		}
		if alerts(email.SecurityChangeOAuthLinked) != 1 || jobs.jobs[len(jobs.jobs)-1].To != ada.Email {
			t.Fatalf("jobs = %+v", jobs.jobs)
		}
		// Linking the same account again changes nothing.
		link(t, adaAuth, 7001, "/settings/accounts")
		if len(list(t, adaAuth)) != 1 || len(f.events(t, ada.ID, audit.OAuthLinked)) != 1 || alerts(email.SecurityChangeOAuthLinked) != 1 {
			t.Fatal("relink was not a no-op")
		}
	})

	t.Run("taken", func(t *testing.T) {
		loc := link(t, bobAuth, 7001, "/settings/accounts")
		if loc.Path != "/sign-in" || loc.Query().Get("error") != CodeOAuthIdentityTaken {
			t.Fatalf("redirect = %s", loc)
		}
		if ids := list(t, bobAuth); len(ids) != 0 {
			t.Fatalf("bob identities = %+v", ids)
		}
		if len(f.events(t, bob.ID, audit.OAuthLinked)) != 0 {
			t.Fatal("taken link audited as oauth.linked")
		}
		var failed int
		if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE event = 'login.failed' AND metadata->>'code' = $1 AND metadata->>'intent' = 'link'`,
			CodeOAuthIdentityTaken).Scan(&failed); err != nil || failed != 1 {
			t.Fatalf("login.failed = %d (%v)", failed, err)
		}
	})

	t.Run("unlink", func(t *testing.T) {
		// Another user cannot unlink it.
		if resp := f.api.Delete(MyIdentitiesPath+"/"+linked.ID, bobAuth); resp.Code != http.StatusGone {
			t.Fatalf("foreign unlink: %d %s", resp.Code, resp.Body)
		}
		// The last connected account can go: email is always a sign-in method.
		if resp := f.api.Delete(MyIdentitiesPath+"/"+linked.ID, adaAuth); resp.Code != http.StatusNoContent {
			t.Fatalf("unlink: %d %s", resp.Code, resp.Body)
		}
		if ids := list(t, adaAuth); len(ids) != 0 {
			t.Fatalf("identities = %+v", ids)
		}
		evs := f.events(t, ada.ID, audit.OAuthUnlinked)
		if len(evs) != 1 {
			t.Fatalf("oauth.unlinked = %d", len(evs))
		}
		var meta map[string]any
		if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil || meta["provider"] != "github" || meta["identity_id"] != linked.ID {
			t.Fatalf("oauth.unlinked metadata = %v (%v)", meta, err)
		}
		if alerts(email.SecurityChangeOAuthUnlinked) != 1 {
			t.Fatalf("jobs = %+v", jobs.jobs)
		}
		if resp := f.api.Delete(MyIdentitiesPath+"/"+linked.ID, adaAuth); resp.Code != http.StatusGone {
			t.Fatalf("second unlink: %d %s", resp.Code, resp.Body)
		}
		// Once unlinked, bob can link it.
		if loc := link(t, bobAuth, 7001, "/"); loc.Query().Get("linked") != "github" {
			t.Fatalf("redirect = %s", loc)
		}
		var owner db.OauthIdentity
		if owner, err = f.q.GetOAuthIdentityByProviderSubject(ctx, db.GetOAuthIdentityByProviderSubjectParams{Provider: "github", Subject: "7001"}); err != nil || owner.UserID != bob.ID {
			t.Fatalf("owner = %+v (%v)", owner, err)
		}
	})
}
