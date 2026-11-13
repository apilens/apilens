package authz_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/authn"
)

func TestRecentAuth(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	user := func(at time.Time) authn.Principal {
		return authn.Principal{Kind: authn.KindUser, UserID: uuid.New(), AuthTime: at}
	}
	cases := []struct {
		name string
		p    authn.Principal
		want bool
	}{
		{"just signed in", user(now), true},
		{"exactly max age", user(now.Add(-10 * time.Minute)), true},
		{"one second too old", user(now.Add(-10*time.Minute - time.Second)), false},
		{"hours old", user(now.Add(-3 * time.Hour)), false},
		{"no auth_time", user(time.Time{}), false},
		{"small clock skew", user(now.Add(authn.Leeway)), true},
		{"far future", user(now.Add(time.Hour)), false},
		{"api key", authn.Principal{Kind: authn.KindAPIKey, AuthTime: now}, false},
		{"oauth client", authn.Principal{Kind: authn.KindClient, AuthTime: now}, false},
	}
	for _, c := range cases {
		if got := authz.RecentAuth(c.p, 10*time.Minute, now); got != c.want {
			t.Errorf("%s: RecentAuth = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRequireRecentAuth(t *testing.T) {
	principals := map[string]authn.Principal{
		"fresh":  {Kind: authn.KindUser, UserID: uuid.New(), AuthTime: time.Now().Add(-time.Minute)},
		"stale":  {Kind: authn.KindUser, UserID: uuid.New(), AuthTime: time.Now().Add(-11 * time.Minute)},
		"legacy": {Kind: authn.KindUser, UserID: uuid.New()},
		"key":    {Kind: authn.KindAPIKey, KeyID: uuid.New(), ProjectID: uuid.New(), OrgID: uuid.New()},
		"client": {Kind: authn.KindClient, ClientID: "ci"},
	}
	for _, maxAge := range []time.Duration{0, 10 * time.Minute} {
		_, api := humatest.New(t)
		api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
			if p, ok := principals[ctx.Header(principalHeader)]; ok {
				ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), p))
			}
			next(ctx)
		})
		reached := 0
		huma.Register(api, huma.Operation{
			OperationID: "sensitive",
			Method:      http.MethodPost,
			Path:        "/sensitive",
			Middlewares: huma.Middlewares{authz.RequireRecentAuth(api, maxAge)},
		}, func(context.Context, *struct{}) (*struct{}, error) {
			reached++
			return nil, nil
		})

		cases := []struct {
			who    string
			status int
			code   string
		}{
			{"fresh", http.StatusNoContent, ""},
			{"stale", http.StatusForbidden, "reauth_required"},
			{"legacy", http.StatusForbidden, "reauth_required"},
			{"key", http.StatusForbidden, "forbidden"},
			{"client", http.StatusForbidden, "forbidden"},
			{"", http.StatusUnauthorized, "unauthenticated"},
		}
		for _, c := range cases {
			before := reached
			resp := api.Post("/sensitive", principalHeader+": "+c.who)
			if resp.Code != c.status || problemCode(t, resp) != c.code {
				t.Errorf("maxAge %v, %q: %d %s, want %d %s", maxAge, c.who, resp.Code, resp.Body, c.status, c.code)
			}
			if wantReach := c.status < 400; (reached > before) != wantReach {
				t.Errorf("maxAge %v, %q: handler reached = %v", maxAge, c.who, reached > before)
			}
		}
	}
}
