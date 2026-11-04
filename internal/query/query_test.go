package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/platform/authn"
)

func TestResolveWindowAlignsToBuckets(t *testing.T) {
	now := time.Date(2026, 10, 22, 10, 37, 12, 0, time.UTC)
	cases := map[string]struct {
		bucket time.Duration
		table  string
		points int
	}{
		"":    {15 * time.Minute, "api_requests_1m", 96},
		"1h":  {time.Minute, "api_requests_1m", 60},
		"6h":  {5 * time.Minute, "api_requests_1m", 72},
		"24h": {15 * time.Minute, "api_requests_1m", 96},
		"7d":  {time.Hour, "api_requests_1h", 168},
	}
	for name, tc := range cases {
		w, err := resolveWindow(name, now)
		if err != nil {
			t.Fatalf("%q: %v", name, err)
		}
		if w.bucket != tc.bucket || w.table != tc.table {
			t.Errorf("%q: bucket=%v table=%s", name, w.bucket, w.table)
		}
		if n := int(w.to.Sub(w.from) / w.bucket); n != tc.points {
			t.Errorf("%q: %d buckets, want %d", name, n, tc.points)
		}
		if !w.to.After(now) || w.to.Sub(now) > w.bucket || w.from.Truncate(w.bucket) != w.from {
			t.Errorf("%q: window [%v, %v) not aligned around now", name, w.from, w.to)
		}
	}
	if _, err := resolveWindow("30d", now); err == nil {
		t.Fatal("expected error for unsupported range")
	}
}

func TestTenantFilterAlwaysStartsWithProject(t *testing.T) {
	pid := uuid.New()
	where, args := tenantFilter(pid, "")
	if where != "project_id = ?" || len(args) != 1 || args[0] != pid {
		t.Fatalf("got %q %v", where, args)
	}
	where, args = tenantFilter(pid, "staging")
	if where != "project_id = ? AND environment = ?" || len(args) != 2 {
		t.Fatalf("got %q %v", where, args)
	}
}

type stubVerifier struct {
	scopes []string
	err    error
}

func (s stubVerifier) Verify(_ context.Context, raw string) (apikeys.Principal, error) {
	if s.err != nil {
		return apikeys.Principal{}, s.err
	}
	if raw != "good" {
		return apikeys.Principal{}, apikeys.ErrInvalidKey
	}
	return apikeys.Principal{ProjectID: uuid.MustParse("11111111-1111-4111-8111-111111111111"), Scopes: s.scopes}, nil
}

type whoami struct {
	Body struct {
		Project string `json:"project"`
	}
}

func TestAuthMiddleware(t *testing.T) {
	cases := map[string]struct {
		verifier stubVerifier
		header   string
		code     int
	}{
		"ok":           {stubVerifier{scopes: []string{"read"}}, "Bearer good", http.StatusOK},
		"missing":      {stubVerifier{scopes: []string{"read"}}, "", http.StatusUnauthorized},
		"invalid":      {stubVerifier{scopes: []string{"read"}}, "Bearer nope", http.StatusUnauthorized},
		"ingest only":  {stubVerifier{scopes: []string{"ingest"}}, "Bearer good", http.StatusForbidden},
		"backend down": {stubVerifier{err: errors.New("pg down")}, "Bearer good", http.StatusServiceUnavailable},
		"wrong scheme": {stubVerifier{scopes: []string{"read"}}, "Basic good", http.StatusUnauthorized},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, api := humatest.New(t)
			api.UseMiddleware(AuthMiddleware(api, tc.verifier, nil))
			huma.Register(api, huma.Operation{OperationID: "who", Method: http.MethodGet, Path: "/who", Security: security},
				func(ctx context.Context, _ *struct{}) (*whoami, error) {
					p, err := principalFrom(ctx)
					if err != nil {
						return nil, err
					}
					out := &whoami{}
					out.Body.Project = p.ProjectID.String()
					return out, nil
				})
			huma.Register(api, huma.Operation{OperationID: "open", Method: http.MethodGet, Path: "/open"},
				func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })

			var resp interface{ Result() *http.Response }
			if tc.header == "" {
				resp = api.Get("/who")
			} else {
				resp = api.Get("/who", "Authorization: "+tc.header)
			}
			res := resp.Result()
			_ = res.Body.Close()
			if res.StatusCode != tc.code {
				t.Fatalf("status = %d, want %d", res.StatusCode, tc.code)
			}
			// Operations without a security requirement stay public.
			open := api.Get("/open").Result()
			_ = open.Body.Close()
			if open.StatusCode >= 400 {
				t.Fatalf("public op = %d", open.StatusCode)
			}
		})
	}
}

// stubProjects grants project.view on "shop" to the user "viewer" and to
// read keys of keyProject; "down" cannot be answered.
type stubProjects struct{ viewer uuid.UUID }

var (
	keyProject  = uuid.MustParse("11111111-1111-4111-8111-111111111111")
	shopProject = keyProject
)

func (s stubProjects) AuthorizeProject(_ context.Context, p authn.Principal, slug string, perm authz.Permission) (authz.Target, error) {
	if perm != authz.ProjectView {
		return authz.Target{}, authz.ErrForbidden
	}
	switch {
	case slug == "down":
		return authz.Target{}, fmt.Errorf("%w: connection refused", authz.ErrUnavailable)
	case slug == "boom":
		return authz.Target{}, errors.New("pg down")
	case slug != "shop":
		return authz.Target{}, authz.ErrNoResource
	case p.Kind == authn.KindUser && p.UserID == s.viewer, p.Kind == authn.KindAPIKey && p.ProjectID == keyProject:
		return authz.Target{ProjectID: shopProject}, nil
	default:
		return authz.Target{}, authz.ErrNoResource
	}
}

// Session callers name the project with ?project= and need project.view on
// it; read keys may name only their own project.
func TestAuthMiddlewareSessionProject(t *testing.T) {
	viewer, stranger := uuid.New(), uuid.New()
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if id := ctx.Header("X-Session"); id != "" {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: uuid.MustParse(id)}))
		}
		next(ctx)
	})
	api.UseMiddleware(AuthMiddleware(api, stubVerifier{scopes: []string{"read"}}, stubProjects{viewer: viewer}))
	huma.Register(api, huma.Operation{OperationID: "who", Method: http.MethodGet, Path: "/who", Security: security},
		func(ctx context.Context, _ *ProjectInput) (*whoami, error) {
			p, err := principalFrom(ctx)
			if err != nil {
				return nil, err
			}
			out := &whoami{}
			out.Body.Project = p.ProjectID.String()
			return out, nil
		})

	cases := []struct {
		name, path, header string
		code               int
	}{
		{"session ok", "/who?project=shop", "X-Session: " + viewer.String(), http.StatusOK},
		{"session without project", "/who", "X-Session: " + viewer.String(), http.StatusUnprocessableEntity},
		{"session other org's project", "/who?project=shop", "X-Session: " + stranger.String(), http.StatusNotFound},
		{"session unknown project", "/who?project=nope", "X-Session: " + viewer.String(), http.StatusNotFound},
		{"authz unavailable", "/who?project=down", "X-Session: " + viewer.String(), http.StatusServiceUnavailable},
		{"authz error", "/who?project=boom", "X-Session: " + viewer.String(), http.StatusInternalServerError},
		{"read key own project", "/who?project=shop", "Authorization: Bearer good", http.StatusOK},
		{"read key other project", "/who?project=nope", "Authorization: Bearer good", http.StatusNotFound},
		{"read key without project", "/who", "Authorization: Bearer good", http.StatusOK},
	}
	for _, tc := range cases {
		resp := api.Get(tc.path, tc.header)
		if resp.Code != tc.code {
			t.Errorf("%s: status = %d, want %d (%s)", tc.name, resp.Code, tc.code, resp.Body)
			continue
		}
		if tc.code == http.StatusOK && !strings.Contains(resp.Body.String(), shopProject.String()) {
			t.Errorf("%s: body = %s, want project %s", tc.name, resp.Body, shopProject)
		}
	}

	// Without an authorizer, sessions fail closed.
	_, closed := humatest.New(t)
	closed.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		next(huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: viewer})))
	})
	closed.UseMiddleware(AuthMiddleware(closed, stubVerifier{scopes: []string{"read"}}, nil))
	huma.Register(closed, huma.Operation{OperationID: "who", Method: http.MethodGet, Path: "/who", Security: security},
		func(context.Context, *ProjectInput) (*struct{}, error) { return nil, nil })
	if resp := closed.Get("/who?project=shop"); resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil authorizer: status = %d, want 503", resp.Code)
	}
}

// A request a session already authenticated (authn.Middleware runs first)
// passes the read-key middleware once its project is authorized, and a read
// key is also exposed as an authn.Principal; operations without readKey are
// left alone.
func TestAuthMiddlewareSharesPrincipal(t *testing.T) {
	_, api := humatest.New(t)
	user := uuid.New()
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if ctx.Header("X-Session") != "" {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: user}))
		}
		next(ctx)
	})
	api.UseMiddleware(AuthMiddleware(api, stubVerifier{scopes: []string{"read"}}, stubProjects{viewer: user}))
	type kind struct {
		Body struct {
			Kind string `json:"kind"`
		}
	}
	handler := func(ctx context.Context, _ *struct{}) (*kind, error) {
		out := &kind{}
		if p, ok := authn.FromContext(ctx); ok {
			out.Body.Kind = string(p.Kind)
		}
		return out, nil
	}
	either := []map[string][]string{{authn.SchemeSession: {}}, {SchemeReadKey: {}}}
	huma.Register(api, huma.Operation{OperationID: "either", Method: http.MethodGet, Path: "/either", Security: either}, handler)
	huma.Register(api, huma.Operation{OperationID: "session", Method: http.MethodGet, Path: "/session",
		Security: []map[string][]string{{authn.SchemeSession: {}}}}, handler)

	cases := []struct {
		path, header string
		code         int
		kind         string
	}{
		{"/either", "Authorization: Bearer good", http.StatusOK, string(authn.KindAPIKey)},
		{"/either?project=shop", "X-Session: 1", http.StatusOK, string(authn.KindUser)},
		{"/either", "", http.StatusUnauthorized, ""},
		// Not a readKey operation: guarding it is authn.Middleware's job.
		{"/session", "Authorization: Bearer nope", http.StatusOK, ""},
	}
	for _, tc := range cases {
		var args []any
		if tc.header != "" {
			args = append(args, tc.header)
		}
		resp := api.Get(tc.path, args...)
		if resp.Code != tc.code {
			t.Fatalf("%s %q: status = %d, want %d", tc.path, tc.header, resp.Code, tc.code)
		}
		if tc.code == http.StatusOK && !strings.Contains(resp.Body.String(), `"kind":"`+tc.kind+`"`) {
			t.Errorf("%s %q: body = %s, want kind %q", tc.path, tc.header, resp.Body.String(), tc.kind)
		}
	}
}
