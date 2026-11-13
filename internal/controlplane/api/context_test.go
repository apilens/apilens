package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/controlplane/usercontext"
	"github.com/apilens/apilens/internal/platform/authn"
)

type fakeContext struct {
	uc  usercontext.Context
	err error
	ids []uuid.UUID
}

func (f *fakeContext) Get(_ context.Context, user uuid.UUID) (usercontext.Context, error) {
	f.ids = append(f.ids, user)
	return f.uc, f.err
}

func newTestContext(t *testing.T, svc ContextService, p *authn.Principal) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	if p != nil {
		api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
			next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), *p)))
		})
	}
	NewContext(svc, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(api)
	return api
}

func TestGetUserContext(t *testing.T) {
	p := &authn.Principal{Kind: authn.KindUser, UserID: uuid.New(), AMR: []string{"email"}}
	orgID, projID := uuid.New(), uuid.New()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	svc := &fakeContext{uc: usercontext.Context{
		User: db.User{
			ID: p.UserID, Email: "ada@example.com", EmailVerifiedAt: &now, Name: "Ada", CreatedAt: now,
			Preferences: []byte(`{"home":"requests","last_project_slug":"checkout"}`),
			Onboarding:  []byte(`{"step":"install","completed":false}`),
		},
		Orgs: []usercontext.Org{{
			ID: orgID, Slug: "acme", Name: "Acme", Role: "viewer",
			Projects: []usercontext.Project{{ID: projID, Slug: "checkout", Name: "Checkout", Environments: []string{"production"}, AppCount: 2, Role: "viewer"}},
		}},
		LastProjectSlug: "checkout",
		Capabilities:    map[string][]string{"checkout": {"project.read"}},
	}}
	api := newTestContext(t, svc, p)

	resp := api.Get(UserContextPath)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"orgs": []any{map[string]any{
			"id": orgID.String(), "slug": "acme", "name": "Acme", "role": "viewer",
			"projects": []any{map[string]any{"id": projID.String(), "slug": "checkout", "name": "Checkout", "environments": []any{"production"}, "app_count": 2, "role": "viewer"}},
		}},
		"last_project_slug": "checkout",
		"onboarding":        map[string]any{"step": "install", "completed": false},
		"capabilities":      map[string]any{"checkout": []any{"project.read"}},
	}
	for k, v := range want {
		gb, _ := json.Marshal(got[k])
		wb, _ := json.Marshal(v)
		if string(gb) != string(wb) {
			t.Errorf("%s = %s, want %s", k, gb, wb)
		}
	}
	user, _ := got["user"].(map[string]any)
	if user["id"] != p.UserID.String() || user["email"] != "ada@example.com" || user["email_verified"] != true {
		t.Errorf("user = %v", user)
	}
	if prefs, _ := user["preferences"].(map[string]any); prefs["last_project_slug"] != "checkout" || prefs["home"] != "requests" {
		t.Errorf("user.preferences = %v", user["preferences"])
	}
	if len(svc.ids) != 1 || svc.ids[0] != p.UserID {
		t.Fatalf("service called with %v", svc.ids)
	}
}

func TestGetUserContextEmpty(t *testing.T) {
	p := &authn.Principal{Kind: authn.KindUser, UserID: uuid.New()}
	api := newTestContext(t, &fakeContext{uc: usercontext.Context{User: db.User{ID: p.UserID}}}, p)
	resp := api.Get(UserContextPath)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		"orgs":              `[]`,
		"last_project_slug": `null`,
		"onboarding":        `{"step":null,"completed":false}`,
		"capabilities":      `{}`,
	} {
		if string(got[k]) != want {
			t.Errorf("%s = %s, want %s", k, got[k], want)
		}
	}
}

func TestGetUserContextErrors(t *testing.T) {
	p := &authn.Principal{Kind: authn.KindUser, UserID: uuid.New()}
	for name, tc := range map[string]struct {
		principal *authn.Principal
		err       error
		status    int
		code      string
	}{
		"no session":   {nil, nil, http.StatusUnauthorized, "unauthenticated"},
		"user deleted": {p, usercontext.ErrNotFound, http.StatusUnauthorized, "session_expired"},
		"store down":   {p, errors.New("boom"), http.StatusInternalServerError, "internal_error"},
		"authz down":   {p, fmt.Errorf("usercontext: capabilities: %w", authz.ErrUnavailable), http.StatusServiceUnavailable, "authz_unavailable"},
	} {
		t.Run(name, func(t *testing.T) {
			resp := newTestContext(t, &fakeContext{err: tc.err}, tc.principal).Get(UserContextPath)
			var body struct{ Code string }
			_ = json.Unmarshal(resp.Body.Bytes(), &body)
			if resp.Code != tc.status || body.Code != tc.code {
				t.Fatalf("status = %d, code = %q: %s", resp.Code, body.Code, resp.Body)
			}
		})
	}
}

func TestOnboardingState(t *testing.T) {
	step := func(s string) *string { return &s }
	for raw, want := range map[string]OnboardingState{
		`{}`:                                 {},
		`{"step":"org"}`:                     {Step: step("org")},
		`{"step":"invite","completed":true}`: {Step: step("invite"), Completed: true},
		`{"completed_at":"2026-01-02T00:00:00Z"}`: {Completed: true},
		`{"step":3,"completed":"yes"}`:            {},
		`not json`:                                {},
	} {
		got := onboardingState([]byte(raw))
		if got.Completed != want.Completed || (got.Step == nil) != (want.Step == nil) || (got.Step != nil && *got.Step != *want.Step) {
			t.Errorf("onboardingState(%s) = %+v, want %+v", raw, got, want)
		}
	}
}
