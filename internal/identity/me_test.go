package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/account"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// fakeAccount is an AccountService returning canned results.
type fakeAccount struct {
	user    db.User
	err     error
	del     account.Deletion
	patches []account.Patch
	ids     []uuid.UUID
}

func (f *fakeAccount) Get(_ context.Context, id uuid.UUID) (db.User, error) {
	f.ids = append(f.ids, id)
	return f.user, f.err
}

func (f *fakeAccount) Update(_ context.Context, id uuid.UUID, p account.Patch) (db.User, error) {
	f.ids = append(f.ids, id)
	f.patches = append(f.patches, p)
	return f.user, f.err
}

func (f *fakeAccount) Delete(_ context.Context, id uuid.UUID) (account.Deletion, error) {
	f.ids = append(f.ids, id)
	return f.del, f.err
}

// newTestAccount serves the account endpoints with p as the authenticated
// principal (nil: none).
func newTestAccount(t *testing.T, svc AccountService, p *authn.Principal) (humatest.TestAPI, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if p != nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), *p))
		}
		next(ctx)
	})
	NewAccount(svc, slog.New(slog.NewJSONHandler(logs, nil))).Register(api)
	return api, logs
}

func testPrincipal() *authn.Principal {
	return &authn.Principal{Kind: authn.KindUser, UserID: uuid.New(), SessionID: uuid.New(), AMR: []string{"passkey"}}
}

func TestGetMe(t *testing.T) {
	p := testPrincipal()
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	svc := &fakeAccount{user: db.User{
		ID: p.UserID, Email: "ada@example.com", Name: "Ada", CreatedAt: created,
		Preferences: []byte(`{"home":"requests","theme":"dark"}`),
		Onboarding:  []byte(`{"step":"about"}`),
	}}
	api, _ := newTestAccount(t, svc, p)

	resp := api.Get(MePath)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var got map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"id": p.UserID.String(), "email": "ada@example.com", "email_verified": false, "name": "Ada", "avatar_url": "",
		"preferences": map[string]any{"home": "requests"},
		"onboarding":  map[string]any{"step": "about"},
		"created_at":  "2026-01-02T03:04:05Z",
		"amr":         []any{"passkey"},
	}
	for k, v := range want {
		gb, _ := json.Marshal(got[k])
		wb, _ := json.Marshal(v)
		if string(gb) != string(wb) {
			t.Errorf("%s = %s, want %s", k, gb, wb)
		}
	}
	if len(svc.ids) != 1 || svc.ids[0] != p.UserID {
		t.Fatalf("service called with %v", svc.ids)
	}
}

func TestPatchMeBuildsPatch(t *testing.T) {
	p := testPrincipal()
	svc := &fakeAccount{user: db.User{ID: p.UserID, Preferences: []byte(`{}`), Onboarding: []byte(`{}`)}}
	api, _ := newTestAccount(t, svc, p)

	resp := api.Patch(MePath, map[string]any{"name": "  Ada  ", "preferences": map[string]any{"home": "endpoints"}})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	got := svc.patches[0]
	if got.Name == nil || *got.Name != "Ada" || got.AvatarURL != nil || got.Preferences["home"] != "endpoints" {
		t.Fatalf("patch = %+v", got)
	}

	resp = api.Patch(MePath, map[string]any{"avatar_url": ""})
	if resp.Code != http.StatusOK {
		t.Fatalf("clear avatar: status = %d: %s", resp.Code, resp.Body)
	}
	if got := svc.patches[1]; got.AvatarURL == nil || *got.AvatarURL != "" || got.Name != nil || got.Preferences != nil {
		t.Fatalf("patch = %+v", got)
	}

	for name, body := range map[string]map[string]any{
		"bad home":     {"preferences": map[string]any{"home": "dashboard"}},
		"unknown pref": {"preferences": map[string]any{"colour": "red"}},
		"bad avatar":   {"avatar_url": "ftp://x"},
		"long name":    {"name": strings.Repeat("a", 121)},
	} {
		if resp := api.Patch(MePath, body); resp.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d", name, resp.Code)
		}
	}
	if len(svc.patches) != 2 {
		t.Fatalf("invalid bodies reached the service: %d calls", len(svc.patches))
	}
}

func TestDeleteMe(t *testing.T) {
	p := testPrincipal()
	after := time.Date(2026, 12, 4, 0, 0, 0, 0, time.UTC)
	svc := &fakeAccount{del: account.Deletion{DeleteAfter: after, SessionsRevoked: 2}}
	api, _ := newTestAccount(t, svc, p)

	resp := api.Delete(MePath)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	if !strings.Contains(resp.Body.String(), `"delete_after":"2026-12-04T00:00:00Z"`) {
		t.Fatalf("body = %s", resp.Body)
	}
}

func TestMeErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want ErrCode
	}{
		{"deleted user", account.ErrNotFound, CodeSessionExpired},
		{"sole owner", account.ErrOwnerTransferRequired, CodeOwnerTransferRequired},
		{"bad preference", account.ErrInvalidPreference, CodeInvalidRequest},
		{"internal", errors.New("db down: secret dsn"), CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api, logs := newTestAccount(t, &fakeAccount{err: tc.err}, testPrincipal())
			resp := api.Delete(MePath)
			var body problemBody
			if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if resp.Code != tc.want.Status() || body.Code != tc.want {
				t.Fatalf("status = %d code = %q, want %q", resp.Code, body.Code, tc.want)
			}
			if strings.Contains(resp.Body.String(), "secret") {
				t.Fatalf("internal error leaked: %s", resp.Body)
			}
			if tc.want == CodeInternal && !strings.Contains(logs.String(), "db down") {
				t.Fatalf("internal error not logged: %s", logs)
			}
		})
	}
}

func TestMeRequiresPrincipal(t *testing.T) {
	svc := &fakeAccount{}
	api, _ := newTestAccount(t, svc, nil)
	for _, resp := range []int{api.Get(MePath).Code, api.Patch(MePath, map[string]any{}).Code, api.Delete(MePath).Code} {
		if resp != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", resp)
		}
	}
	if len(svc.ids) != 0 {
		t.Fatal("service called without a principal")
	}
}

func TestMeOperationsDeclareSession(t *testing.T) {
	_, api := humatest.New(t)
	NewAccount(nil, nil).Register(api)
	item := api.OpenAPI().Paths[MePath]
	for _, op := range []*huma.Operation{item.Get, item.Patch, item.Delete} {
		if op == nil || !authn.Declares(op, authn.SchemeSession) {
			t.Fatalf("operation %+v does not declare the session scheme", op)
		}
	}
	if _, ok := item.Delete.Responses["409"]; !ok {
		t.Fatal("DELETE does not document owner_transfer_required (409)")
	}
}
