package query

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
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

func TestIsRouteTemplate(t *testing.T) {
	for p, want := range map[string]bool{
		"/orders/{id}":       true,
		"/users/:id":         true,
		"/files/<path:name>": true,
		"/orders/1042":       false,
		"/charge":            false,
		"orders?expand=1":    false,
		"/time/10:30":        false,
	} {
		if got := isRouteTemplate(p); got != want {
			t.Errorf("isRouteTemplate(%q) = %v, want %v", p, got, want)
		}
	}
}

// What the log shows finds its rows (#983): a raw URL in the path filter and a
// consumer name in the consumer filter.
func TestRequestFilterMatchesWhatTheLogShows(t *testing.T) {
	c, a, err := requestFilter(&requestsInput{Path: "/orders/{id}"}, nil, nil)
	if err != nil || !slices.Equal(c, []string{"path = ?"}) || !slices.Equal(a, []any{"/orders/{id}"}) {
		t.Fatalf("template: %q %v %v", c, a, err)
	}
	c, a, err = requestFilter(&requestsInput{Path: "/orders/10_42"}, nil, nil)
	if err != nil || !slices.Equal(c, []string{"(path = ? OR raw_path ILIKE ?)"}) || !slices.Equal(a, []any{"/orders/10_42", `%/orders/10\_42%`}) {
		t.Fatalf("raw URL: %q %v %v", c, a, err)
	}
	c, a, err = requestFilter(&requestsInput{ConsumerID: "Acme Corp"}, nil, nil)
	if err != nil || !slices.Equal(c, []string{"(consumer_id = ? OR consumer_name = ?)"}) || !slices.Equal(a, []any{"Acme Corp", "Acme Corp"}) {
		t.Fatalf("consumer: %q %v %v", c, a, err)
	}
	// The timeline and exports read the same filter.
	if c, _, _ := requestFilter((&requestTimelineInput{Path: "/orders/1", ConsumerID: "acme"}).filter(), nil, nil); len(c) != 2 || c[0] != "(consumer_id = ? OR consumer_name = ?)" {
		t.Fatalf("timeline clauses = %q", c)
	}
	if c, _, _ := requestFilter(ExportFilter{Path: "/orders/1"}.input(), nil, nil); !slices.Equal(c, []string{"(path = ? OR raw_path ILIKE ?)"}) {
		t.Fatalf("export clauses = %q", c)
	}
}

func TestRequestFilterApp(t *testing.T) {
	app := uuid.New()
	clauses, args, err := requestFilter(&requestsInput{App: strings.ToUpper(app.String())}, []string{"project_id = ?"}, []any{"p"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(clauses, []string{"project_id = ?", "app_id = ?"}) || len(args) != 2 || args[1] != app {
		t.Fatalf("clauses = %q args = %v", clauses, args)
	}
	// The timeline and exports carry app into the same filter.
	if c, _, _ := requestFilter((&requestTimelineInput{App: app.String()}).filter(), nil, nil); !slices.Equal(c, []string{"app_id = ?"}) {
		t.Fatalf("timeline clauses = %q", c)
	}
	if c, _, _ := requestFilter(ExportFilter{App: app.String()}.input(), nil, nil); !slices.Equal(c, []string{"app_id = ?"}) {
		t.Fatalf("export clauses = %q", c)
	}
	if _, _, err := requestFilter(&requestsInput{App: "storefront"}, nil, nil); err == nil {
		t.Fatal("app slug accepted")
	}
}

func TestEndpointFilterApp(t *testing.T) {
	project, app := uuid.New(), uuid.New()
	w := window{from: time.Unix(0, 0), to: time.Unix(60, 0)}
	where, args, err := endpointFilter(project, &endpointRequestsInput{Path: "/orders"}, "POST", "bucket", w, false)
	if err != nil || strings.Contains(where, "app_id") || len(args) != 5 {
		t.Fatalf("no app: %q %v %v", where, args, err)
	}
	where, args, err = endpointFilter(project, &endpointRequestsInput{Path: "/orders", App: app.String()}, "POST", "bucket", w, false)
	if err != nil || !strings.HasPrefix(where, "project_id = ? AND app_id = ? AND method = ?") || args[1] != app {
		t.Fatalf("app: %q %v %v", where, args, err)
	}
	if _, _, err := endpointFilter(project, &endpointRequestsInput{Path: "/orders", App: "x"}, "POST", "bucket", w, false); err == nil {
		t.Fatal("bad app accepted")
	}
}
