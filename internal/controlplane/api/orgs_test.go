package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
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
