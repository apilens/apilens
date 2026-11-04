package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/platform/authn"
)

type fakeMembers struct{ err error }

func (f *fakeMembers) Members(context.Context, uuid.UUID, string) ([]orgs.Member, error) {
	return nil, f.err
}

func (f *fakeMembers) ChangeRole(context.Context, uuid.UUID, string, uuid.UUID, string) (orgs.Member, error) {
	return orgs.Member{}, f.err
}

func (f *fakeMembers) RemoveMember(context.Context, uuid.UUID, string, uuid.UUID) error { return f.err }
func (f *fakeMembers) Leave(context.Context, uuid.UUID, string) error                   { return f.err }
func (f *fakeMembers) TransferOwnership(context.Context, uuid.UUID, string, uuid.UUID) error {
	return f.err
}

func newMembersAPI(t *testing.T, svc MemberService, user uuid.UUID) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	authn.AddSecurityScheme(api)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if user != uuid.Nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user}))
		}
		next(ctx)
	})
	NewMembers(svc, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(api)
	return api
}

func TestMemberErrors(t *testing.T) {
	target := uuid.New().String()
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{orgs.ErrNotFound, http.StatusForbidden, "forbidden"},
		{orgs.ErrForbidden, http.StatusForbidden, "forbidden"},
		{orgs.ErrMemberNotFound, http.StatusGone, "member_gone"},
		{orgs.ErrLastOwner, http.StatusConflict, "last_owner"},
		{orgs.ErrInvalid, http.StatusBadRequest, "invalid_request"},
		{errors.New("boom"), http.StatusInternalServerError, "internal_error"},
	} {
		api := newMembersAPI(t, &fakeMembers{err: tc.err}, uuid.New())
		for name, resp := range map[string]*httptest.ResponseRecorder{
			"list":     api.Get("/api/v1/orgs/acme/members"),
			"patch":    api.Patch("/api/v1/orgs/acme/members/"+target, map[string]any{"role": "admin"}),
			"delete":   api.Delete("/api/v1/orgs/acme/members/" + target),
			"leave":    api.Post("/api/v1/orgs/acme/leave", map[string]any{}),
			"transfer": api.Post("/api/v1/orgs/acme/transfer-ownership", map[string]any{"user_id": target}),
		} {
			var p struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(resp.Body.Bytes(), &p)
			if resp.Code != tc.status || p.Code != tc.code {
				t.Errorf("%s %v: %d %s", name, tc.err, resp.Code, resp.Body)
			}
		}
	}
}

func TestMembersRequireUser(t *testing.T) {
	api := newMembersAPI(t, &fakeMembers{}, uuid.Nil)
	if resp := api.Get("/api/v1/orgs/acme/members"); resp.Code != http.StatusUnauthorized {
		t.Fatalf("list: %d", resp.Code)
	}
	if resp := api.Post("/api/v1/orgs/acme/leave", map[string]any{}); resp.Code != http.StatusUnauthorized {
		t.Fatalf("leave: %d", resp.Code)
	}
}

func TestMemberPathValidation(t *testing.T) {
	api := newMembersAPI(t, &fakeMembers{}, uuid.New())
	if resp := api.Patch("/api/v1/orgs/acme/members/not-a-uuid", map[string]any{"role": "admin"}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad user id: %d %s", resp.Code, resp.Body)
	}
	if resp := api.Post("/api/v1/orgs/acme/transfer-ownership", map[string]any{"user_id": "nope"}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad transfer user id: %d %s", resp.Code, resp.Body)
	}
}
