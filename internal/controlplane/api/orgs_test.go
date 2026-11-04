package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

type fakeOrgs struct {
	createErr error
	owner     uuid.UUID
	available bool
	sugg      []string
	err       error // returned by List, Get, Update and Delete
	update    orgs.Update
}

func (f *fakeOrgs) Create(_ context.Context, owner uuid.UUID, name, slug string) (orgs.Org, error) {
	f.owner = owner
	if f.createErr != nil {
		return orgs.Org{}, f.createErr
	}
	return orgs.Org{ID: uuid.New(), Slug: slug, Name: name, Role: orgs.RoleOwner, CreatedAt: time.Now()}, nil
}

func (f *fakeOrgs) Available(context.Context, string) (bool, []string, error) {
	return f.available, f.sugg, nil
}

func (f *fakeOrgs) List(context.Context, uuid.UUID) ([]orgs.Summary, error) {
	return nil, f.err
}

func (f *fakeOrgs) Get(_ context.Context, _ uuid.UUID, slug string) (orgs.Detail, error) {
	return orgs.Detail{Org: orgs.Org{ID: uuid.New(), Slug: slug, Name: "Acme", Role: orgs.RoleAdmin, CreatedAt: time.Now()}}, f.err
}

func (f *fakeOrgs) Update(ctx context.Context, user uuid.UUID, slug string, u orgs.Update) (orgs.Detail, error) {
	f.update = u
	return f.Get(ctx, user, slug)
}

func (f *fakeOrgs) Delete(context.Context, uuid.UUID, string) error { return f.err }

func (f *fakeOrgs) Joinable(context.Context, uuid.UUID) ([]orgs.Joinable, error) {
	return nil, f.err
}

func (f *fakeOrgs) Join(_ context.Context, _ uuid.UUID, slug string) (orgs.Org, bool, error) {
	if f.err != nil {
		return orgs.Org{}, false, f.err
	}
	return orgs.Org{ID: uuid.New(), Slug: slug, Name: "Acme", Role: orgs.RoleMember, CreatedAt: time.Now()}, true, nil
}

func newOrgsAPI(t *testing.T, svc OrgService, user uuid.UUID) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if user != uuid.Nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user}))
		}
		next(ctx)
	})
	NewOrgs(svc, nil, ratelimit.Rate{}, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(api)
	return api
}

func TestCreateOrgErrors(t *testing.T) {
	user := uuid.New()
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&orgs.SlugTakenError{Suggestions: []string{"acme-2"}}, http.StatusConflict, "slug_taken"},
		{orgs.ErrInvalid, http.StatusBadRequest, "invalid_request"},
		{orgs.ErrUserGone, http.StatusUnauthorized, "session_expired"},
		{errors.New("boom"), http.StatusInternalServerError, "internal_error"},
	} {
		svc := &fakeOrgs{createErr: tc.err}
		resp := newOrgsAPI(t, svc, user).Post(OrgsPath, map[string]any{"name": "Acme", "slug": "acme"})
		var p struct {
			Code        string   `json:"code"`
			Suggestions []string `json:"suggestions"`
		}
		_ = json.Unmarshal(resp.Body.Bytes(), &p)
		if resp.Code != tc.status || p.Code != tc.code {
			t.Errorf("%v: %d %s", tc.err, resp.Code, resp.Body)
		}
		if tc.code == "slug_taken" && !slices.Equal(p.Suggestions, []string{"acme-2"}) {
			t.Errorf("suggestions = %v", p.Suggestions)
		}
		if svc.owner != user {
			t.Errorf("owner = %v, want %v", svc.owner, user)
		}
	}
}

func TestCreateOrgCreated(t *testing.T) {
	resp := newOrgsAPI(t, &fakeOrgs{}, uuid.New()).Post(OrgsPath, map[string]any{"name": "Acme", "slug": "acme"})
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var o Org
	if err := json.Unmarshal(resp.Body.Bytes(), &o); err != nil || o.Slug != "acme" || o.Role != "owner" {
		t.Fatalf("org = %+v (%v)", o, err)
	}
}

func TestOrgsRequireUser(t *testing.T) {
	api := newOrgsAPI(t, &fakeOrgs{}, uuid.Nil)
	if resp := api.Post(OrgsPath, map[string]any{"name": "Acme", "slug": "acme"}); resp.Code != http.StatusUnauthorized {
		t.Fatalf("create: %d", resp.Code)
	}
	if resp := api.Get(SlugAvailablePath + "?slug=acme"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("slug-available: %d", resp.Code)
	}
}

func TestSlugAvailableEmptySuggestions(t *testing.T) {
	resp := newOrgsAPI(t, &fakeOrgs{available: true}, uuid.New()).Get(SlugAvailablePath + "?slug=acme")
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d", resp.Code)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(resp.Body.Bytes(), &raw)
	if string(raw["available"]) != "true" || string(raw["suggestions"]) != "[]" {
		t.Fatalf("body = %s", resp.Body)
	}
}

func TestOrgErrors(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{orgs.ErrNotFound, http.StatusForbidden, "forbidden"},
		{orgs.ErrForbidden, http.StatusForbidden, "forbidden"},
		{orgs.ErrSlugImmutable, http.StatusConflict, "slug_immutable"},
		{&orgs.DomainNotAllowedError{Domain: "gmail.com"}, http.StatusBadRequest, "domain_not_allowed"},
		{orgs.ErrInvalid, http.StatusBadRequest, "invalid_request"},
		{errors.New("boom"), http.StatusInternalServerError, "internal_error"},
	} {
		api := newOrgsAPI(t, &fakeOrgs{err: tc.err}, uuid.New())
		for _, resp := range []*httptest.ResponseRecorder{
			api.Get(OrgsPath + "/acme"),
			api.Patch(OrgsPath+"/acme", map[string]any{"name": "Acme"}),
			api.Delete(OrgsPath + "/acme"),
			api.Post(OrgsPath + "/acme/join"),
		} {
			var p struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(resp.Body.Bytes(), &p)
			if resp.Code != tc.status || p.Code != tc.code {
				t.Errorf("%v: %d %s", tc.err, resp.Code, resp.Body)
			}
		}
	}
}

func TestListOrgsEmptyIsArray(t *testing.T) {
	resp := newOrgsAPI(t, &fakeOrgs{}, uuid.New()).Get(OrgsPath)
	if resp.Code != http.StatusOK || strings.TrimSpace(resp.Body.String()) != "[]" {
		t.Fatalf("list: %d %s", resp.Code, resp.Body)
	}
}

func TestUpdateOrgPassesOnlySetFields(t *testing.T) {
	svc := &fakeOrgs{}
	resp := newOrgsAPI(t, svc, uuid.New()).Patch(OrgsPath+"/acme", map[string]any{"allowed_domains": []string{}, "domain_join": false})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	u := svc.update
	if u.Name != nil || u.Slug != nil || u.AllowedDomains == nil || len(*u.AllowedDomains) != 0 || u.DomainJoin == nil || *u.DomainJoin {
		t.Fatalf("update = %+v", u)
	}
	var d OrgDetail
	if err := json.Unmarshal(resp.Body.Bytes(), &d); err != nil || d.AllowedDomains == nil {
		t.Fatalf("detail = %+v (%v): %s", d, err, resp.Body)
	}
}

func TestOrgOpsRequireUser(t *testing.T) {
	api := newOrgsAPI(t, &fakeOrgs{}, uuid.Nil)
	for _, resp := range []*httptest.ResponseRecorder{
		api.Get(OrgsPath),
		api.Get(OrgsPath + "/acme"),
		api.Patch(OrgsPath+"/acme", map[string]any{"name": "Acme"}),
		api.Delete(OrgsPath + "/acme"),
		api.Get(JoinableOrgsPath),
		api.Post(OrgsPath + "/acme/join"),
	} {
		if resp.Code != http.StatusUnauthorized {
			t.Errorf("status = %d: %s", resp.Code, resp.Body)
		}
	}
}

func TestJoinableOrgsEmptyIsArray(t *testing.T) {
	resp := newOrgsAPI(t, &fakeOrgs{}, uuid.New()).Get(JoinableOrgsPath)
	if resp.Code != http.StatusOK || strings.TrimSpace(resp.Body.String()) != "[]" {
		t.Fatalf("joinable: %d %s", resp.Code, resp.Body)
	}
	resp = newOrgsAPI(t, &fakeOrgs{err: orgs.ErrUserGone}, uuid.New()).Get(JoinableOrgsPath)
	if resp.Code != http.StatusUnauthorized || !strings.Contains(resp.Body.String(), "session_expired") {
		t.Fatalf("user gone: %d %s", resp.Code, resp.Body)
	}
}

func TestJoinOrgReturnsOrg(t *testing.T) {
	resp := newOrgsAPI(t, &fakeOrgs{}, uuid.New()).Post(OrgsPath + "/acme/join")
	var o Org
	if err := json.Unmarshal(resp.Body.Bytes(), &o); resp.Code != http.StatusOK || err != nil || o.Slug != "acme" || o.Role != "member" {
		t.Fatalf("join: %d %s", resp.Code, resp.Body)
	}
}
