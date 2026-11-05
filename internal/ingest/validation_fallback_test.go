package ingest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/apilens/apilens/internal/pipeline"
)

func TestParseValidationBodyFrameworkFixtures(t *testing.T) {
	cases := map[string][]pipeline.ValidationError{
		"fastapi.json": {
			{Loc: "body.email", Msg: "Field required", Type: "missing"},
			{Loc: "query.limit", Msg: "Input should be a valid integer, unable to parse string as an integer", Type: "int_parsing"},
		},
		"ninja.json": {
			{Loc: "body.payload.items.0.sku", Msg: "String should have at least 3 characters", Type: "string_too_short"},
		},
		"litestar.json": {
			{Loc: "body.quantity", Msg: "Expected `int`, got `str`"},
			{Msg: "Object missing required field `sku`"},
		},
		"zod.json": {
			{Loc: "user.email", Msg: "Required", Type: "invalid_type"},
			{Loc: "items", Msg: "Array must contain at least 1 element(s)", Type: "too_small"},
		},
		"zod-wrapped.json": {
			{Loc: "email", Msg: "Invalid email", Type: "invalid_string"},
		},
		"class-validator.json": {
			{Loc: "email", Msg: "email must be an email", Type: "isEmail"},
			{Loc: "address.zip", Msg: "zip should not be empty", Type: "isNotEmpty"},
			{Loc: "address.zip", Msg: "zip must be a postal code", Type: "isPostalCode"},
		},
		"nestjs.json": {
			{Msg: "email must be an email"},
			{Msg: "name should not be empty"},
		},
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			body, err := os.ReadFile(filepath.Join("testdata", "validation", name))
			if err != nil {
				t.Fatal(err)
			}
			if got := parseValidationBody(string(body)); !reflect.DeepEqual(got, want) {
				t.Fatalf("got  %+v\nwant %+v", got, want)
			}
		})
	}
}

func TestParseValidationBodyUnknownShapesAreNoOps(t *testing.T) {
	for _, body := range []string{
		``,
		`not json`,
		`{"detail":[{"loc":`, // truncated payload
		`null`,
		`42`,
		`"Unprocessable Entity"`,
		`{}`,
		`[]`,
		`{"detail":"Unprocessable Entity"}`,
		`{"detail":[{"msg":"no loc, not a pydantic error"}]}`,
		`{"error":"invalid_request","error_description":"bad"}`,
		`{"errors":[{"field":"email","reason":"bad"}]}`,
		`{"message":["no statusCode, not NestJS"]}`,
		`{"issues":[{"message":"no path"}]}`,
		`[{"property":"","constraints":{"x":"y"}}]`,
		`[1,"two",null]`,
		`<html><body>422</body></html>`,
	} {
		if got := parseValidationBody(body); got != nil {
			t.Errorf("parseValidationBody(%q) = %+v, want nil", body, got)
		}
	}
}

func TestParseValidationBodyCapsEntries(t *testing.T) {
	many := make([]string, 30)
	for i := range many {
		many[i] = fmt.Sprintf(`{"loc":["body","f%d"],"msg":%q,"type":"missing"}`, i, strings.Repeat("m", 2000))
	}
	got := parseValidationBody(`{"detail":[` + strings.Join(many, ",") + `]}`)
	if len(got) != maxValidationErrors {
		t.Fatalf("len = %d, want %d", len(got), maxValidationErrors)
	}
	if len(got[0].Msg) != maxShortFieldChars {
		t.Fatalf("msg not bounded: %d chars", len(got[0].Msg))
	}

	// A deep class-validator tree stops at the depth bound; a wide one at the cap.
	node := `{"property":"leaf","constraints":{"a":"x"}}`
	for i := 0; i < 50; i++ {
		node = fmt.Sprintf(`{"property":"p%d","constraints":{"a":"x"},"children":[%s]}`, i, node)
	}
	got = parseValidationBody(`[` + node + `]`)
	if len(got) != maxValidationDepth {
		t.Fatalf("deep tree: len = %d, want %d", len(got), maxValidationDepth)
	}
	wide := make([]string, 30)
	for i := range wide {
		wide[i] = fmt.Sprintf(`{"property":"p%d","constraints":{"a":"x"}}`, i)
	}
	if got := parseValidationBody(`[` + strings.Join(wide, ",") + `]`); len(got) != maxValidationErrors {
		t.Fatalf("wide tree: len = %d, want %d", len(got), maxValidationErrors)
	}
}

func TestRequestValidationErrorsFallbackRules(t *testing.T) {
	fastapi := `{"detail":[{"loc":["body","email"],"msg":"Field required","type":"missing"}]}`
	derived := []pipeline.ValidationError{{Loc: "body.email", Msg: "Field required", Type: "missing"}}

	if got := requestValidationErrors(http.StatusUnprocessableEntity, nil, fastapi); !reflect.DeepEqual(got, derived) {
		t.Errorf("422 without SDK errors: got %+v, want %+v", got, derived)
	}
	if got := requestValidationErrors(http.StatusUnprocessableEntity, json.RawMessage(`[]`), fastapi); !reflect.DeepEqual(got, derived) {
		t.Errorf("422 with empty SDK errors: got %+v, want %+v", got, derived)
	}
	// Only 422s are parsed.
	for _, status := range []int{http.StatusOK, http.StatusBadRequest, http.StatusInternalServerError} {
		if got := requestValidationErrors(status, nil, fastapi); got != nil {
			t.Errorf("status %d: got %+v, want nil", status, got)
		}
	}
	// SDK-sent errors win over the payload.
	sent := json.RawMessage(`[{"loc":"query.q","msg":"from sdk","type":"t"}]`)
	want := []pipeline.ValidationError{{Loc: "query.q", Msg: "from sdk", Type: "t"}}
	if got := requestValidationErrors(http.StatusUnprocessableEntity, sent, fastapi); !reflect.DeepEqual(got, want) {
		t.Errorf("SDK errors: got %+v, want %+v", got, want)
	}
}

func TestRequestsDeriveValidationErrorsFrom422Payload(t *testing.T) {
	payload, err := json.Marshal(`{"detail":[{"loc":["body","email"],"msg":"Field required","type":"missing"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	record := strings.Replace(validRequest, `"status_code":503`, `"status_code":422`, 1)
	record = strings.Replace(record, `"release":"v1.2.3"`, `"release":"v1.2.3","response_payload":`+string(payload), 1)

	sink := &fakeSink{}
	if rec := post(t, newEdge(t, fakeVerifier{}, sink), "/v1/requests", record, nil); rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body)
	}
	want := []pipeline.ValidationError{{Loc: "body.email", Msg: "Field required", Type: "missing"}}
	if got := sink.requests[0].ValidationErrors; !reflect.DeepEqual(got, want) {
		t.Errorf("validation_errors = %+v, want %+v", got, want)
	}

	// An unparseable 422 body is still accepted, with no validation errors.
	sink = &fakeSink{}
	record = strings.Replace(validRequest, `"status_code":503`, `"status_code":422`, 1)
	record = strings.Replace(record, `"release":"v1.2.3"`, `"release":"v1.2.3","response_payload":"{\"detail\":[{\"loc\""`, 1)
	if rec := post(t, newEdge(t, fakeVerifier{}, sink), "/v1/requests", record, nil); rec.Code != http.StatusOK || sink.requests[0].ValidationErrors != nil {
		t.Fatalf("unparseable 422 body: %d %s %+v", rec.Code, rec.Body, sink.requests)
	}
}
