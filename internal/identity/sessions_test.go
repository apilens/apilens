package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
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
