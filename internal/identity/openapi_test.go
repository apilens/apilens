package identity

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
)

func TestOperationDocumentsProblemResponses(t *testing.T) {
	_, api := humatest.New(t)
	op := Operation(api, huma.Operation{
		OperationID: "verify-code",
		Method:      http.MethodPost,
		Path:        "/auth/verify",
		Summary:     "Verify an email code",
		Tags:        []string{"Auth"},
	}, CodeInvalidCode, CodeCodeExpired, CodeTooManyAttempts, CodeRateLimited, CodeInvalidCode)
	huma.Register(api, op, func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })

	got := api.OpenAPI().Paths["/auth/verify"].Post
	if got.Summary == "" || !slices.Equal(got.Tags, []string{"Auth"}) {
		t.Fatalf("summary/tags = %q %v", got.Summary, got.Tags)
	}
	if _, ok := got.Responses["default"]; ok {
		t.Fatal("unexpected default response; errors should be explicit")
	}
	want := map[string][]string{
		"400": {"code_expired", "invalid_code"},
		"429": {"rate_limited", "too_many_attempts"},
	}
	for status, codes := range want {
		r := got.Responses[status]
		if r == nil {
			t.Fatalf("missing %s response", status)
		}
		if c, _ := r.Extensions[CodesExtension].([]string); !slices.Equal(c, codes) {
			t.Fatalf("%s codes = %v, want %v", status, c, codes)
		}
		mt := r.Content[ProblemContentType]
		if mt == nil || mt.Schema == nil || mt.Schema.Ref != "#/components/schemas/Problem" {
			t.Fatalf("%s content = %+v", status, r.Content)
		}
	}
	if got.Responses["429"].Headers["Retry-After"] == nil {
		t.Fatal("429 lacks Retry-After header")
	}
	problem := api.OpenAPI().Components.Schemas.Map()["Problem"]
	if problem == nil || problem.Properties["code"] == nil || problem.Properties["retry_after"] == nil {
		t.Fatalf("Problem schema lacks code/retry_after: %+v", problem)
	}
}

func TestOperationRejectsUndocumented(t *testing.T) {
	_, api := humatest.New(t)
	full := huma.Operation{OperationID: "x", Method: http.MethodGet, Path: "/x", Summary: "X", Tags: []string{"Auth"}}
	cases := map[string]func(){
		"no summary": func() { o := full; o.Summary = ""; Operation(api, o) },
		"no tags":    func() { o := full; o.Tags = nil; Operation(api, o) },
		"no id":      func() { o := full; o.OperationID = ""; Operation(api, o) },
		"bad code":   func() { Operation(api, full, ErrCode("nope")) },
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("expected panic")
				}
			}()
			fn()
		})
	}
}
