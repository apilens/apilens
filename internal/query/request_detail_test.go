package query

import (
	"encoding/base64"
	"testing"
)

func TestRequestIDRoundTrip(t *testing.T) {
	for _, id := range []requestID{
		{1767225600123, "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"},
		{1, "", ""},
		{42, "4bf92f3577b34da6a3ce929d0e0e4736", ""},
	} {
		got, err := decodeRequestID(id.encode())
		if err != nil || got != id {
			t.Fatalf("%+v round-tripped to %+v, %v", id, got, err)
		}
	}
	for _, bad := range []string{"%%", base64.RawURLEncoding.EncodeToString([]byte("12:abc")), base64.RawURLEncoding.EncodeToString([]byte("x:a:b"))} {
		if _, err := decodeRequestID(bad); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestParseRequestValidationErrors(t *testing.T) {
	got := parseRequestValidationErrors(`[{"loc":"body.qty","msg":"must be positive","type":"value_error"}]`)
	if len(got) != 1 || got[0] != (requestValidationError{Loc: "body.qty", Msg: "must be positive", Type: "value_error"}) {
		t.Fatalf("got %+v", got)
	}
	for _, empty := range []string{"", "  ", "null", "not json", `{"loc":"x"}`} {
		if got := parseRequestValidationErrors(empty); got == nil || len(got) != 0 {
			t.Errorf("%q = %#v, want an empty slice", empty, got)
		}
	}
}
