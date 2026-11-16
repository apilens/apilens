package audit

import (
	"errors"
	"testing"
	"time"
)

func TestCursorRoundTrip(t *testing.T) {
	at := time.Date(2026, 11, 13, 10, 0, 0, 123456000, time.UTC)
	gotAt, gotID, err := decodeCursor(encodeCursor(at, 42))
	if err != nil || !gotAt.Equal(at) || gotID != 42 {
		t.Fatalf("decode = %v %d %v", gotAt, gotID, err)
	}
	for _, bad := range []string{"bogus!", "bm9waXBl", encodeCursor(at, 1)[:4]} {
		if _, _, err := decodeCursor(bad); !errors.Is(err, ErrInvalidCursor) {
			t.Errorf("decode %q: %v", bad, err)
		}
	}
}

func TestQueryFilter(t *testing.T) {
	f, err := Query{Action: "api_key."}.filter()
	if err != nil || f.prefix == nil || *f.prefix != "api_key." || f.event != nil || f.limit != DefaultPageSize {
		t.Fatalf("prefix filter = %+v %v", f, err)
	}
	f, _ = Query{Action: "api_key.created", Limit: 1000}.filter()
	if f.event == nil || *f.event != "api_key.created" || f.prefix != nil || f.limit != MaxPageSize {
		t.Fatalf("exact filter = %+v", f)
	}
	if _, err := (Query{Cursor: "x"}).filter(); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("bad cursor: %v", err)
	}
}

func TestActions(t *testing.T) {
	actions := Actions()
	seen := map[Kind]bool{}
	for _, a := range actions {
		if accountOnly[a.Kind] || a.Label == "" {
			t.Errorf("action %+v", a)
		}
		seen[a.Kind] = true
	}
	if !seen[APIKeyCreated] || !seen[MemberAdded] || seen[LoginSucceeded] {
		t.Fatalf("actions = %+v", actions)
	}
	if APIKeyCreated.Label() != "API key created" || Kind("project.slug_renamed").Label() != "Project slug renamed" {
		t.Fatalf("labels %q %q", APIKeyCreated.Label(), Kind("project.slug_renamed").Label())
	}
	for k := range accountOnly {
		if !k.Valid() {
			t.Errorf("accountOnly names unknown kind %s", k)
		}
	}
}
