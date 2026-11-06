package apps

import (
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"orders-api":                   "orders-api",
		"Orders API":                   "orders-api",
		"  orders_api  ":               "orders-api",
		"ORDERS   API":                 "orders-api",
		"orders--api":                  "orders-api",
		"-orders-":                     "orders",
		"Café Service!":                "caf-service",
		"svc.v2":                       "svcv2",
		"9lives":                       "9lives",
		"_x_":                          "x",
		strings.Repeat("a", 70):        strings.Repeat("a", 63),
		strings.Repeat("a", 62) + "-b": strings.Repeat("a", 62),
	}
	for in, want := range cases {
		got, ok := Normalize(in)
		if !ok || got != want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", in, got, ok, want)
		}
		if !ValidSlug(got) {
			t.Errorf("Normalize(%q) = %q is not a valid slug", in, got)
		}
	}
	for _, in := range []string{"", "   ", "!!!", "---", "日本"} {
		if got, ok := Normalize(in); ok {
			t.Errorf("Normalize(%q) = %q, want not ok", in, got)
		}
	}
}

func TestDisplayName(t *testing.T) {
	if got := DisplayName("  Orders \t API "); got != "Orders API" {
		t.Fatalf("got %q", got)
	}
	if got := DisplayName(strings.Repeat("é", 120)); len([]rune(got)) != MaxNameLen {
		t.Fatalf("len %d", len([]rune(got)))
	}
}
