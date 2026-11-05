package ingest

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/pipeline"
)

func TestTruncateIsRuneSafe(t *testing.T) {
	if got := truncate("héllo", 2); got != "hé" {
		t.Fatalf("got %q", got)
	}
	if got := truncate("ok\xffbad", 10); !strings.Contains(got, "�") {
		t.Fatalf("invalid utf-8 not replaced: %q", got)
	}
}

func TestHexID(t *testing.T) {
	cases := map[string]string{
		"4BF92F3577B34DA6A3CE929D0E0E4736": "4bf92f3577b34da6a3ce929d0e0e4736",
		strings.Repeat("0", 32):            "",
		"4bf92f3577b34da6a3ce929d0e0e473":  "",
		"zzf92f3577b34da6a3ce929d0e0e4736": "",
	}
	for in, want := range cases {
		if got := hexID(in, 32); got != want {
			t.Errorf("hexID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLogLevel(t *testing.T) {
	for in, want := range map[string]string{"warn": "WARNING", "error": "ERROR", "": "INFO", "weird": "INFO", "fatal": "CRITICAL", "trace": "DEBUG"} {
		if got := logLevel(in); got != want {
			t.Errorf("logLevel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFlexTime(t *testing.T) {
	cases := map[string]time.Time{
		`"2026-10-22T10:00:00Z"`:             time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC),
		`"2026-10-22T15:30:00+05:30"`:        time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC),
		`"2026-10-22T10:00:00.5"`:            time.Date(2026, 10, 22, 10, 0, 0, 500000000, time.UTC),
		`"2026-10-22 10:00:00.000001+00:00"`: time.Date(2026, 10, 22, 10, 0, 0, 1000, time.UTC),
		`1792670400`:                         time.Unix(1792670400, 0).UTC(),
	}
	for in, want := range cases {
		var ft flexTime
		if err := json.Unmarshal([]byte(in), &ft); err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if !ft.Equal(want) {
			t.Errorf("%s -> %v, want %v", in, ft.Time, want)
		}
	}
	var ft flexTime
	if err := json.Unmarshal([]byte(`"not a time"`), &ft); err == nil {
		t.Fatal("expected error")
	}
}

func TestAttributesBounds(t *testing.T) {
	in := map[string]json.RawMessage{}
	for i := range 100 {
		in[fmt.Sprintf("key%03d", i)] = json.RawMessage(`"` + strings.Repeat("v", 600) + `"`)
	}
	in[strings.Repeat("k", 70)] = json.RawMessage(`1`)
	out := attributes(in)
	if len(out) != maxAttributes {
		t.Fatalf("len = %d", len(out))
	}
	for k, v := range out {
		if len(k) > maxAttributeKeyChars || len(v) > maxAttributeValueChars {
			t.Fatalf("unbounded attribute %q=%d chars", k, len(v))
		}
	}
}

func TestRequestAttributesCap(t *testing.T) {
	in := map[string]json.RawMessage{}
	for i := range 50 {
		in[fmt.Sprintf("key%03d", i)] = json.RawMessage(`"v"`)
	}
	if out := attributesN(in, maxRequestAttributes); len(out) != maxRequestAttributes {
		t.Fatalf("len = %d, want %d", len(out), maxRequestAttributes)
	}
}

func TestSampled(t *testing.T) {
	yes, no := true, false
	if !sampled(nil) || !sampled(&yes) || sampled(&no) {
		t.Fatal("sampled: absent and true mean sampled in, false means sampled out")
	}
}

func TestValidationErrors(t *testing.T) {
	// A real FastAPI 422 detail entry (loc as a path array) next to the
	// SDK's flattened form and assorted junk that must be dropped.
	raw := json.RawMessage(`[
		{"loc":["body","items",0,"name"],"msg":"Field required","type":"missing","input":{}},
		{"loc":"query.limit","msg":"Input should be a valid integer","type":"int_parsing"},
		"not an object",
		{},
		{"loc":{"nested":true},"msg":42,"type":null}
	]`)
	got := validationErrors(raw)
	want := []pipeline.ValidationError{
		{Loc: "body.items.0.name", Msg: "Field required", Type: "missing"},
		{Loc: "query.limit", Msg: "Input should be a valid integer", Type: "int_parsing"},
		{Loc: "", Msg: "42", Type: ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}

	for _, bad := range []string{``, `null`, `{"loc":"x"}`, `"x"`, `[`, `[]`} {
		if got := validationErrors(json.RawMessage(bad)); got != nil {
			t.Errorf("validationErrors(%q) = %+v, want nil", bad, got)
		}
	}

	many := make([]string, 30)
	for i := range many {
		many[i] = fmt.Sprintf(`{"loc":%q,"msg":%q,"type":"t"}`, strings.Repeat("l", 400), strings.Repeat("m", 2000))
	}
	got = validationErrors(json.RawMessage("[" + strings.Join(many, ",") + "]"))
	if len(got) != maxValidationErrors {
		t.Fatalf("len = %d, want %d", len(got), maxValidationErrors)
	}
	if len(got[0].Loc) != maxValidationLocChars || len(got[0].Msg) != maxShortFieldChars {
		t.Fatalf("entries not bounded: loc %d, msg %d chars", len(got[0].Loc), len(got[0].Msg))
	}
}
