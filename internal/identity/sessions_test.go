package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
)

const testRefresh = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// fakeSessions is a SessionService returning canned results.
type fakeSessions struct {
	tokens     session.Tokens
	refreshErr error
	logoutErr  error
	got        []string
	list       []session.Active
	listErr    error
	listArgs   [2]uuid.UUID
	revokeErr  error
	revoked    int64
	calls      []string
}

func (f *fakeSessions) Revoke(_ context.Context, user, id uuid.UUID) error {
	f.calls = append(f.calls, "revoke "+user.String()+" "+id.String())
	return f.revokeErr
}

func (f *fakeSessions) RevokeOthers(_ context.Context, user, sid uuid.UUID) (int64, error) {
	f.calls = append(f.calls, "others "+user.String()+" "+sid.String())
	return f.revoked, f.revokeErr
}

func (f *fakeSessions) LogoutAll(_ context.Context, user uuid.UUID) (int64, error) {
	f.calls = append(f.calls, "all "+user.String())
	return f.revoked, f.revokeErr
}

func (f *fakeSessions) List(_ context.Context, user, sid uuid.UUID) ([]session.Active, error) {
	f.listArgs = [2]uuid.UUID{user, sid}
	return f.list, f.listErr
}

func (f *fakeSessions) Refresh(_ context.Context, raw string) (session.Tokens, error) {
	f.got = append(f.got, raw)
	return f.tokens, f.refreshErr
}

func (f *fakeSessions) Logout(_ context.Context, raw string) error {
	f.got = append(f.got, raw)
	return f.logoutErr
}

func newTestSessions(t *testing.T, svc SessionService) (humatest.TestAPI, *bytes.Buffer) {
	t.Helper()
	return newTestSessionsAs(t, svc, nil)
}

// newTestSessionsAs is newTestSessions with p stored as the caller of every
// request, standing in for authn.Middleware.
func newTestSessionsAs(t *testing.T, svc SessionService, p *authn.Principal) (humatest.TestAPI, *bytes.Buffer) {
	t.Helper()
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := NewSessions(config.IdentityConfig{}, svc, limiter, logger)
	now := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return now }
	_, api := humatest.New(t)
	if p != nil {
		api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
			next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), *p)))
		})
	}
	s.Register(api)
	return api, logs
}

func TestRefreshEndpoint(t *testing.T) {
	verified := time.Now()
	user := db.User{ID: uuid.New(), Email: "ada@example.com", EmailVerifiedAt: &verified, Name: "Ada", AvatarUrl: "https://a/x.png"}
	svc := &fakeSessions{tokens: session.Tokens{
		AccessToken:     "access.jwt.token",
		AccessExpiresAt: time.Unix(1_700_000_000, 0).Add(15 * time.Minute),
		RefreshToken:    "next-refresh",
		User:            user,
	}}
	api, _ := newTestSessions(t, svc)

	resp := api.Post(AuthPrefix+"/refresh", map[string]any{"refresh_token": testRefresh})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"access_token":  "access.jwt.token",
		"refresh_token": "next-refresh",
		"expires_in":    float64(900),
		"user": map[string]any{
			"id": user.ID.String(), "email": "ada@example.com", "email_verified": true, "name": "Ada", "avatar_url": "https://a/x.png",
		},
	}
	if got, w := fmt.Sprint(body), fmt.Sprint(want); got != w {
		t.Fatalf("body = %s\nwant %s", got, w)
	}
	if len(svc.got) != 1 || svc.got[0] != testRefresh {
		t.Fatalf("service got %v", svc.got)
	}

	if resp := api.Post(AuthPrefix+"/refresh", map[string]any{"refresh_token": ""}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty token: status = %d", resp.Code)
	}
}

func TestRefreshEndpointErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   ErrCode
	}{
		{"unknown", session.ErrInvalidToken, http.StatusUnauthorized, CodeInvalidToken},
		{"reuse", session.ErrReuseDetected, http.StatusUnauthorized, CodeInvalidToken},
		{"expired", session.ErrExpired, http.StatusUnauthorized, CodeSessionExpired},
		{"internal", errors.New("db down"), http.StatusInternalServerError, CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api, logs := newTestSessions(t, &fakeSessions{refreshErr: tc.err})
			resp := api.Post(AuthPrefix+"/refresh", map[string]any{"refresh_token": testRefresh})
			var p Problem
			if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil {
				t.Fatal(err)
			}
			if resp.Code != tc.status || p.Code != tc.code {
				t.Fatalf("status = %d code = %q, want %d %q", resp.Code, p.Code, tc.status, tc.code)
			}
			if strings.Contains(logs.String(), testRefresh) || strings.Contains(resp.Body.String(), testRefresh) {
				t.Fatal("refresh token leaked into logs or the response")
			}
		})
	}
}

func TestLogoutEndpoint(t *testing.T) {
	svc := &fakeSessions{}
	api, _ := newTestSessions(t, svc)
	resp := api.Post(AuthPrefix+"/logout", map[string]any{"refresh_token": testRefresh})
	if resp.Code != http.StatusNoContent || resp.Body.Len() != 0 {
		t.Fatalf("status = %d body %q", resp.Code, resp.Body)
	}
	if len(svc.got) != 1 || svc.got[0] != testRefresh {
		t.Fatalf("service got %v", svc.got)
	}

	api, logs := newTestSessions(t, &fakeSessions{logoutErr: errors.New("db down")})
	resp = api.Post(AuthPrefix+"/logout", map[string]any{"refresh_token": testRefresh})
	if resp.Code != http.StatusInternalServerError || strings.Contains(logs.String(), testRefresh) {
		t.Fatalf("status = %d, logs %q", resp.Code, logs)
	}
}

func TestListMySessionsEndpoint(t *testing.T) {
	user, sid := uuid.New(), uuid.New()
	created := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	ip := netip.MustParseAddr("203.0.113.7")
	svc := &fakeSessions{list: []session.Active{
		{Session: db.Session{ID: sid, FamilyID: sid, DeviceLabel: "Chrome on macOS", UserAgent: "Mozilla/5.0", Ip: &ip, Amr: []string{"email"},
			CreatedAt: created, LastSeenAt: created.Add(time.Hour), ExpiresAt: created.Add(720 * time.Hour)}, Current: true},
		{Session: db.Session{ID: uuid.New(), DeviceLabel: "curl", UserAgent: "curl/8.4.0",
			CreatedAt: created, LastSeenAt: created, ExpiresAt: created.Add(24 * time.Hour)}},
	}}
	api, _ := newTestSessionsAs(t, svc, &authn.Principal{Kind: authn.KindUser, UserID: user, SessionID: sid, AMR: []string{"email"}})

	resp := api.Get(MySessionsPath)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	if svc.listArgs != [2]uuid.UUID{user, sid} {
		t.Fatalf("service got %v, want user and sid of the caller", svc.listArgs)
	}
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Sessions) != 2 {
		t.Fatalf("sessions = %v", body.Sessions)
	}
	first, second := body.Sessions[0], body.Sessions[1]
	if first["id"] != sid.String() || first["current"] != true || first["device_label"] != "Chrome on macOS" ||
		first["ip"] != "203.0.113.7" || first["created_at"] != "2026-11-01T09:00:00Z" || first["last_seen_at"] != "2026-11-01T10:00:00Z" {
		t.Fatalf("first = %v", first)
	}
	if second["current"] != false || second["ip"] != nil || fmt.Sprint(second["amr"]) != "[]" {
		t.Fatalf("second = %v", second)
	}
	if _, ok := first["token_hash"]; ok {
		t.Fatal("token hash exposed")
	}
}

func TestListMySessionsEndpointErrors(t *testing.T) {
	// Without a user principal (no or an API-key credential) the handler refuses.
	for _, p := range []*authn.Principal{nil, {Kind: authn.KindAPIKey, KeyID: uuid.New()}} {
		api, _ := newTestSessionsAs(t, &fakeSessions{}, p)
		resp := api.Get(MySessionsPath)
		var prob Problem
		_ = json.Unmarshal(resp.Body.Bytes(), &prob)
		if resp.Code != http.StatusUnauthorized || prob.Code != CodeUnauthenticated {
			t.Fatalf("principal %v: status = %d code = %q", p, resp.Code, prob.Code)
		}
	}

	api, logs := newTestSessionsAs(t, &fakeSessions{listErr: errors.New("db down")}, &authn.Principal{Kind: authn.KindUser, UserID: uuid.New(), SessionID: uuid.New()})
	resp := api.Get(MySessionsPath)
	if resp.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), "db down") {
		t.Fatalf("status = %d, logs %q", resp.Code, logs)
	}
}

func TestRevokeEndpoints(t *testing.T) {
	user, sid, target := uuid.New(), uuid.New(), uuid.New()
	caller := &authn.Principal{Kind: authn.KindUser, UserID: user, SessionID: sid, AMR: []string{"email"}}

	svc := &fakeSessions{revoked: 3}
	api, _ := newTestSessionsAs(t, svc, caller)

	resp := api.Delete(MySessionsPath + "/" + target.String())
	if resp.Code != http.StatusNoContent || resp.Body.Len() != 0 {
		t.Fatalf("delete: status = %d body %q", resp.Code, resp.Body)
	}
	resp = api.Post(MySessionsPath + "/revoke-others")
	if resp.Code != http.StatusOK || strings.TrimSpace(resp.Body.String()) != `{"revoked":3}` {
		t.Fatalf("revoke-others: status = %d body %s", resp.Code, resp.Body)
	}
	resp = api.Post(AuthPrefix + "/logout-all")
	if resp.Code != http.StatusNoContent {
		t.Fatalf("logout-all: status = %d body %s", resp.Code, resp.Body)
	}
	want := []string{
		"revoke " + user.String() + " " + target.String(),
		"others " + user.String() + " " + sid.String(),
		"all " + user.String(),
	}
	if fmt.Sprint(svc.calls) != fmt.Sprint(want) {
		t.Fatalf("calls = %v\nwant %v", svc.calls, want)
	}

	if resp := api.Delete(MySessionsPath + "/not-a-uuid"); resp.Code != http.StatusUnprocessableEntity || len(svc.calls) != 3 {
		t.Fatalf("bad id: status = %d", resp.Code)
	}
}

func TestRevokeEndpointsErrors(t *testing.T) {
	requests := map[string]func(humatest.TestAPI) *httptest.ResponseRecorder{
		"delete": func(api humatest.TestAPI) *httptest.ResponseRecorder {
			return api.Delete(MySessionsPath + "/" + uuid.NewString())
		},
		"revoke-others": func(api humatest.TestAPI) *httptest.ResponseRecorder {
			return api.Post(MySessionsPath + "/revoke-others")
		},
		"logout-all": func(api humatest.TestAPI) *httptest.ResponseRecorder { return api.Post(AuthPrefix + "/logout-all") },
	}
	problem := func(t *testing.T, resp *httptest.ResponseRecorder) Problem {
		t.Helper()
		var p Problem
		_ = json.Unmarshal(resp.Body.Bytes(), &p)
		return p
	}
	for name, do := range requests {
		t.Run(name, func(t *testing.T) {
			for _, p := range []*authn.Principal{nil, {Kind: authn.KindAPIKey, KeyID: uuid.New()}} {
				svc := &fakeSessions{}
				api, _ := newTestSessionsAs(t, svc, p)
				resp := do(api)
				if resp.Code != http.StatusUnauthorized || problem(t, resp).Code != CodeUnauthenticated || len(svc.calls) != 0 {
					t.Fatalf("principal %v: status = %d calls %v", p, resp.Code, svc.calls)
				}
			}
			caller := &authn.Principal{Kind: authn.KindUser, UserID: uuid.New(), SessionID: uuid.New()}
			api, logs := newTestSessionsAs(t, &fakeSessions{revokeErr: errors.New("db down")}, caller)
			resp := do(api)
			if resp.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), "db down") {
				t.Fatalf("status = %d, logs %q", resp.Code, logs)
			}
		})
	}

	caller := &authn.Principal{Kind: authn.KindUser, UserID: uuid.New(), SessionID: uuid.New()}
	api, _ := newTestSessionsAs(t, &fakeSessions{revokeErr: session.ErrExpired}, caller)
	resp := api.Post(MySessionsPath + "/revoke-others")
	if resp.Code != http.StatusUnauthorized || problem(t, resp).Code != CodeSessionExpired {
		t.Fatalf("expired current session: status = %d %s", resp.Code, resp.Body)
	}
}
