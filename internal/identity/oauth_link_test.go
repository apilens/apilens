package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// fakeOAuthIdentities is an in-memory OAuthIdentities.
type fakeOAuthIdentities struct {
	users  map[uuid.UUID]db.User
	idents []db.OauthIdentity
	err    error
}

func newFakeOAuthIdentities(users ...db.User) *fakeOAuthIdentities {
	f := &fakeOAuthIdentities{users: map[uuid.UUID]db.User{}}
	for _, u := range users {
		f.users[u.ID] = u
	}
	return f
}

func (f *fakeOAuthIdentities) List(_ context.Context, user uuid.UUID) ([]db.OauthIdentity, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []db.OauthIdentity
	for _, i := range f.idents {
		if i.UserID == user {
			out = append(out, i)
		}
	}
	return out, nil
}

func (f *fakeOAuthIdentities) Link(_ context.Context, user uuid.UUID, ext ExternalIdentity) (db.User, bool, error) {
	if f.err != nil {
		return db.User{}, false, f.err
	}
	u, ok := f.users[user]
	if !ok {
		return db.User{}, false, ErrOAuthLinkUserGone
	}
	for _, i := range f.idents {
		if i.Provider == ext.Provider && i.Subject == ext.Subject {
			if i.UserID != user {
				return db.User{}, false, ErrOAuthIdentityTaken
			}
			return u, false, nil
		}
	}
	profile, _ := json.Marshal(ext.Profile)
	f.idents = append(f.idents, db.OauthIdentity{ID: uuid.New(), UserID: user, Provider: ext.Provider, Subject: ext.Subject, Email: &ext.Email, Profile: profile})
	return u, true, nil
}

func (f *fakeOAuthIdentities) Unlink(_ context.Context, user, id uuid.UUID) (db.User, db.OauthIdentity, error) {
	if f.err != nil {
		return db.User{}, db.OauthIdentity{}, f.err
	}
	for n, i := range f.idents {
		if i.ID == id && i.UserID == user {
			f.idents = append(f.idents[:n], f.idents[n+1:]...)
			return f.users[user], i, nil
		}
	}
	return db.User{}, db.OauthIdentity{}, ErrOAuthIdentityNotFound
}

// linkHarness is a callback harness whose flows are started by user.
func linkHarness(t *testing.T, user db.User) (*callbackHarness, *fakeOAuthIdentities, *fakeJobs) {
	t.Helper()
	h := newCallbackHarness(t)
	idents := newFakeOAuthIdentities(user)
	jobs := &fakeJobs{}
	h.o.signIn.Identities, h.o.signIn.Jobs = idents, jobs
	h.o.CurrentUser = func(context.Context) (string, bool) { return user.ID.String(), true }
	return h, idents, jobs
}

func TestOAuthLinkCallback(t *testing.T) {
	ada := db.User{ID: uuid.New(), Email: "ada@example.com"}

	t.Run("links and returns to next", func(t *testing.T) {
		h, idents, jobs := linkHarness(t, ada)
		f := beginOAuth(t, h.api, "github", "intent=link&next="+url.QueryEscape("/settings/accounts?tab=1"))
		h.idp.Grant("c", githubGrant(f, 42, githubEmail{Email: "ada.gh@example.com", Primary: true, Verified: true}))
		loc := h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}})
		if got := loc.Scheme + "://" + loc.Host + loc.Path; got != testUIURL+"/settings/accounts" {
			t.Fatalf("redirect = %s", loc)
		}
		if q := loc.Query(); q.Get("linked") != "github" || q.Get("tab") != "1" || q.Get("code") != "" {
			t.Fatalf("redirect query = %v", q)
		}
		if len(idents.idents) != 1 || idents.idents[0].UserID != ada.ID || idents.idents[0].Subject != "42" {
			t.Fatalf("identities = %+v", idents.idents)
		}
		if len(jobs.jobs) != 1 || jobs.jobs[0].To != ada.Email || jobs.jobs[0].Template != email.TemplateSecurityChange ||
			jobs.jobs[0].Data["change"] != email.SecurityChangeOAuthLinked {
			t.Fatalf("jobs = %+v", jobs.jobs)
		}
		// No session is created and nothing is handed off.
		if len(h.sessions.metas) != 0 || h.handoff.n != 0 || len(h.users.seen) != 0 {
			t.Fatal("a link signed someone in")
		}
	})

	t.Run("already linked to the same user is a no-op", func(t *testing.T) {
		h, idents, jobs := linkHarness(t, ada)
		idents.idents = append(idents.idents, db.OauthIdentity{ID: uuid.New(), UserID: ada.ID, Provider: "github", Subject: "42"})
		f := beginOAuth(t, h.api, "github", "intent=link")
		h.idp.Grant("c", githubGrant(f, 42, githubEmail{Email: "ada@example.com", Primary: true, Verified: true}))
		loc := h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}})
		if loc.Path != "/" || loc.Query().Get("linked") != "github" {
			t.Fatalf("redirect = %s", loc)
		}
		if len(idents.idents) != 1 || len(jobs.jobs) != 0 {
			t.Fatalf("identities = %d, jobs = %d", len(idents.idents), len(jobs.jobs))
		}
	})

	t.Run("taken by another user", func(t *testing.T) {
		h, idents, jobs := linkHarness(t, ada)
		idents.idents = append(idents.idents, db.OauthIdentity{ID: uuid.New(), UserID: uuid.New(), Provider: "google", Subject: "g-bob"})
		f := beginOAuth(t, h.api, "google", "intent=link")
		h.idp.Grant("c", googleGrant(f, "g-bob", "bob@example.com"))
		wantSignInError(t, h.callback(t, "google", url.Values{"code": {"c"}, "state": {f.state}}), CodeOAuthIdentityTaken)
		if len(idents.idents) != 1 || len(jobs.jobs) != 0 {
			t.Fatalf("identities = %d, jobs = %d", len(idents.idents), len(jobs.jobs))
		}
		ev := h.lastEvent(t)
		if ev.Kind != audit.LoginFailed || ev.Meta["code"] != CodeOAuthIdentityTaken || ev.Meta["intent"] != OAuthIntentLink {
			t.Fatalf("audit = %+v", ev)
		}
	})

	t.Run("user gone", func(t *testing.T) {
		h, _, _ := linkHarness(t, ada)
		h.o.CurrentUser = func(context.Context) (string, bool) { return uuid.NewString(), true }
		f := beginOAuth(t, h.api, "github", "intent=link")
		h.idp.Grant("c", githubGrant(f, 42, githubEmail{Email: "ada@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), string(CodeSessionExpired))
	})

	t.Run("store failure", func(t *testing.T) {
		h, idents, _ := linkHarness(t, ada)
		idents.err = errors.New("db down")
		f := beginOAuth(t, h.api, "github", "intent=link")
		h.idp.Grant("c", githubGrant(f, 42, githubEmail{Email: "ada@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), string(CodeInternal))
	})

	t.Run("not configured", func(t *testing.T) {
		h := newCallbackHarness(t)
		h.o.CurrentUser = func(context.Context) (string, bool) { return ada.ID.String(), true }
		f := beginOAuth(t, h.api, "github", "intent=link")
		h.idp.Grant("c", githubGrant(f, 42, githubEmail{Email: "ada@example.com", Primary: true, Verified: true}))
		wantSignInError(t, h.callback(t, "github", url.Values{"code": {"c"}, "state": {f.state}}), string(CodeInternal))
	})
}

func TestOAuthStartLinkUsesSessionPrincipal(t *testing.T) {
	user := uuid.New()
	states := newMemStates()
	_, o := newTestOAuth(t, testOAuthCfg, states, nil)
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user})))
	})
	o.Register(api)
	st, err := states.Take(context.Background(), mustLocation(t, api.Get(startPath("github", "intent=link"))).Query().Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Intent != OAuthIntentLink || st.LinkUserID != user.String() {
		t.Fatalf("state = %+v", st)
	}
	if _, ok := sessionUser(authn.WithPrincipal(context.Background(), authn.Principal{Kind: authn.KindAPIKey})); ok {
		t.Fatal("an API key resolved to a user")
	}
}

func newTestConnectedAccounts(t *testing.T, deps ConnectedAccountsDeps, p *authn.Principal) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if p != nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), *p))
		}
		next(ctx)
	})
	c := NewConnectedAccounts(deps, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	c.now = func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) }
	c.Register(api)
	return api
}

func TestConnectedAccounts(t *testing.T) {
	ada := db.User{ID: uuid.New(), Email: "ada@example.com"}
	principal := &authn.Principal{Kind: authn.KindUser, UserID: ada.ID}
	created := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	addr := "ada.gh@example.com"
	gh := db.OauthIdentity{
		ID: uuid.New(), UserID: ada.ID, Provider: "github", Subject: "42", Email: &addr,
		Profile: []byte(`{"login":"ada","name":"Ada","avatar_url":"https://example.com/a.png"}`), CreatedAt: created,
	}
	google := db.OauthIdentity{
		ID: uuid.New(), UserID: ada.ID, Provider: "google", Subject: "g",
		Profile: []byte(`{"name":"Ada L","picture":"https://example.com/g.png"}`), CreatedAt: created, LastLoginAt: &created,
	}

	t.Run("list", func(t *testing.T) {
		idents := newFakeOAuthIdentities(ada)
		idents.idents = []db.OauthIdentity{gh, google, {ID: uuid.New(), UserID: uuid.New(), Provider: "github", Subject: "7", Profile: []byte(`{}`)}}
		api := newTestConnectedAccounts(t, ConnectedAccountsDeps{Identities: idents, Jobs: &fakeJobs{}}, principal)
		resp := api.Get(MyIdentitiesPath)
		if resp.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		var out struct{ Identities []ConnectedAccount }
		if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Identities) != 2 {
			t.Fatalf("identities = %+v", out.Identities)
		}
		a, b := out.Identities[0], out.Identities[1]
		if a.ID != gh.ID.String() || a.Provider != "github" || a.Email == nil || *a.Email != addr || a.Username != "ada" ||
			a.Name != "Ada" || a.AvatarURL != "https://example.com/a.png" || a.LastLoginAt != nil || !a.CreatedAt.Equal(created) {
			t.Errorf("github = %+v", a)
		}
		if b.Provider != "google" || b.Email != nil || b.Username != "" || b.AvatarURL != "https://example.com/g.png" || b.LastLoginAt == nil {
			t.Errorf("google = %+v", b)
		}
	})

	t.Run("list empty is an empty array", func(t *testing.T) {
		api := newTestConnectedAccounts(t, ConnectedAccountsDeps{Identities: newFakeOAuthIdentities(ada), Jobs: &fakeJobs{}}, principal)
		resp := api.Get(MyIdentitiesPath)
		if resp.Code != http.StatusOK || !bytes.Contains(resp.Body.Bytes(), []byte(`"identities":[]`)) {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
	})

	for _, tc := range []struct {
		name     string
		p        *authn.Principal
		id       string
		err      error
		status   int
		code     ErrCode
		enqueued int
	}{
		{"unlink the last account", principal, gh.ID.String(), nil, http.StatusNoContent, "", 1},
		{"unauthenticated", nil, gh.ID.String(), nil, http.StatusUnauthorized, CodeUnauthenticated, 0},
		{"unknown id", principal, uuid.NewString(), nil, http.StatusGone, CodeOAuthIdentityGone, 0},
		{"another user's id", &authn.Principal{Kind: authn.KindUser, UserID: uuid.New()}, gh.ID.String(), nil, http.StatusGone, CodeOAuthIdentityGone, 0},
		{"store down", principal, gh.ID.String(), errors.New("boom"), http.StatusInternalServerError, CodeInternal, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			idents := newFakeOAuthIdentities(ada)
			idents.idents = []db.OauthIdentity{gh}
			idents.err = tc.err
			jobs := &fakeJobs{}
			api := newTestConnectedAccounts(t, ConnectedAccountsDeps{Identities: idents, Jobs: jobs}, tc.p)
			resp := api.Delete(MyIdentitiesPath + "/" + tc.id)
			if resp.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", resp.Code, tc.status, resp.Body)
			}
			if tc.code != "" {
				var p Problem
				_ = json.Unmarshal(resp.Body.Bytes(), &p)
				if p.Code != tc.code {
					t.Errorf("code = %q, want %q", p.Code, tc.code)
				}
			}
			if len(jobs.jobs) != tc.enqueued {
				t.Fatalf("enqueued %d jobs, want %d", len(jobs.jobs), tc.enqueued)
			}
			if tc.enqueued > 0 {
				if len(idents.idents) != 0 {
					t.Fatal("identity not removed")
				}
				a := jobs.jobs[0]
				if a.To != ada.Email || a.Template != email.TemplateSecurityChange || a.Data["change"] != email.SecurityChangeOAuthUnlinked {
					t.Errorf("job = %+v", a)
				}
			}
		})
	}
}

func TestConnectedAccountsOperations(t *testing.T) {
	_, api := humatest.New(t)
	NewConnectedAccounts(ConnectedAccountsDeps{}, nil).Register(api)
	for _, op := range []*huma.Operation{
		api.OpenAPI().Paths[MyIdentitiesPath].Get,
		api.OpenAPI().Paths[MyIdentitiesPath+"/{id}"].Delete,
	} {
		if op == nil {
			t.Fatal("operation not registered")
		}
		if !authn.Declares(op, authn.SchemeSession) {
			t.Errorf("%s: security = %v, want session", op.OperationID, op.Security)
		}
	}
}
