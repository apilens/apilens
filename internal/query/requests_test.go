package query

import (
	"slices"
	"strings"
	"testing"
)

func TestParseStatusFilter(t *testing.T) {
	cases := map[string][]statusRange{
		"":                  nil,
		"all":               nil,
		"ALL":               nil,
		"5xx":               {{500, 599}},
		"404":               {{404, 404}},
		"500-503":           {{500, 503}},
		"200, 4XX ,500-502": {{200, 200}, {400, 499}, {500, 502}},
		"1xx":               {{100, 199}},
	}
	for in, want := range cases {
		got, err := parseStatusFilter(in)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if !slices.Equal(got, want) {
			t.Errorf("%q = %v, want %v", in, got, want)
		}
	}
	for _, bad := range []string{"6xx", "abc", "99", "600", "503-500", "500-", "200,,404", strings.Repeat("200,", maxStatusTerms) + "200"} {
		if _, err := parseStatusFilter(bad); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestRequestCursorRoundTrip(t *testing.T) {
	for _, c := range []requestCursor{{1767225600123, "4bf92f3577b34da6a3ce929d0e0e4736"}, {1, ""}, {42, "a:b"}} {
		got, err := decodeRequestCursor(c.encode())
		if err != nil || got != c {
			t.Fatalf("%+v round-tripped to %+v, %v", c, got, err)
		}
	}
	// Not base64, "no-colon", "xx:y".
	for _, bad := range []string{"!!", "bm8tY29sb24", "eHg6eQ"} {
		if _, err := decodeRequestCursor(bad); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestLikeContainsEscapes(t *testing.T) {
	if got := likeContains(`50%_off\`); got != `%50\%\_off\\%` {
		t.Fatalf("got %q", got)
	}
}

func TestRequestFilterClauses(t *testing.T) {
	in := &requestsInput{Method: "post", Status: "4xx,500", hasLatencyMax: true}
	clauses, args, err := requestFilter(in, []string{"project_id = ?"}, []any{"p"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"project_id = ?", "method = ?", "response_time_ms <= ?", "(status_code BETWEEN ? AND ? OR status_code BETWEEN ? AND ?)"}
	if !slices.Equal(clauses, want) {
		t.Fatalf("clauses = %q", clauses)
	}
	if len(args) != 7 || args[1] != "POST" {
		t.Fatalf("args = %v", args)
	}
	if _, _, err := requestFilter(&requestsInput{Cursor: "%%"}, nil, nil); err == nil {
		t.Fatal("bad cursor accepted")
	}
	if _, _, err := requestFilter(&requestsInput{Status: "7xx"}, nil, nil); err == nil {
		t.Fatal("bad status accepted")
	}
}
