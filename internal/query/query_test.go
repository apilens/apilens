package query

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
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
			api.UseMiddleware(AuthMiddleware(api, tc.verifier))
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
