package piiaudit

import (
	"slices"
	"strings"
	"testing"
)

func detector(t *testing.T, name string) Detector {
	t.Helper()
	for _, d := range DefaultDetectors() {
		if d.Name == name {
			return d
		}
	}
	t.Fatalf("no detector %q", name)
	return Detector{}
}

// detectorCases lists, per detector, values it must find (whole, as the
// match) and values it must not find anything in.
var detectorCases = map[string]struct{ hit, miss []string }{
	"email": {
		hit:  []string{"jane.doe@example.com", "a+tag@mail.example.co.uk", "X_Y-1%z@sub-domain.example.org"},
		miss: []string{"@example.com", "jane@localhost", "jane at example dot com", "[redacted]"},
	},
	"card": {
		hit: []string{
			"4111111111111111",    // Visa, 16
			"4111 1111 1111 1111", // grouped with spaces
			"5500-0000-0000-0004", // grouped with dashes
			"378282246310005",     // Amex, 15
			"4222222222222",       // 13 digits
			"6011000990139424",    // Discover
		},
		miss: []string{
			"4111111111111112",          // fails Luhn
			"0000000000000000",          // repeated digit
			"411111111111",              // 12 digits
			"41111111111111111111",      // 20 digits
			"order 1234567812345678 ok", // fails Luhn
			"v4111111111111111",         // no word boundary
		},
	},
	"iban": {
		hit:  []string{"GB82WEST12345698765432", "GB82 WEST 1234 5698 7654 32", "DE89370400440532013000", "FR1420041010050500013M02606"},
		miss: []string{"GB82WEST12345698765433", "DE89370400440532013001", "gb82west12345698765432", "AB12"},
	},
	"jwt": {
		hit: []string{
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			"eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.", // unsigned
		},
		miss: []string{"eyJhbGciOiJIUzI1NiJ9", "abc.def.ghi", "eyJhbGciOiJIUzI1NiJ9.notjson.sig"},
	},
	"us_ssn": {
		hit:  []string{"123-45-6789", "078-05-1120"},
		miss: []string{"000-12-3456", "666-12-3456", "912-34-5678", "123-00-4567", "123-45-0000", "123456789", "1123-45-6789"},
	},
	"uk_nino": {
		hit:  []string{"AB123456C", "AB 12 34 56 C", "JG103759A"},
		miss: []string{"QQ123456C", "GB123456A", "AB123456E", "DA123456A", "ab123456c"},
	},
	"in_pan": {
		hit:  []string{"ABCPE1234F", "AAACB1234C"},
		miss: []string{"ABCXE1234F", "ABCPE12345", "abcpe1234f", "ABCPE1234FG"},
	},
}

func TestDetectors(t *testing.T) {
	for _, d := range DefaultDetectors() {
		c, ok := detectorCases[d.Name]
		if !ok {
			t.Errorf("detector %q has no test cases", d.Name)
			continue
		}
		t.Run(d.Name, func(t *testing.T) {
			for _, v := range c.hit {
				got := d.Find("value: " + v + ", end")
				if !slices.Equal(got, []string{v}) {
					t.Errorf("Find(%q) = %q, want [%q]", v, got, v)
				}
			}
			for _, v := range c.miss {
				if got := d.Find(v); len(got) > 0 {
					t.Errorf("Find(%q) = %q, want none", v, got)
				}
			}
		})
	}
}

func TestDetectorFindsEveryMatch(t *testing.T) {
	got := detector(t, "email").Find(`{"to":"a@example.com","cc":["b@example.com"]}`)
	if !slices.Equal(got, []string{"a@example.com", "b@example.com"}) {
		t.Fatalf("Find = %q", got)
	}
}

func TestLuhn(t *testing.T) {
	for digits, want := range map[string]bool{"79927398713": true, "79927398710": false, "0": true, "18": true, "19": false} {
		if got := luhn(digits); got != want {
			t.Errorf("luhn(%q) = %v, want %v", digits, got, want)
		}
	}
}

func TestParsePattern(t *testing.T) {
	d, err := ParsePattern(` member_id = \bM-\d{6}\b `)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name != "member_id" || !slices.Equal(d.Find("id M-123456 and M-12"), []string{"M-123456"}) {
		t.Fatalf("got %q finding %q", d.Name, d.Find("id M-123456 and M-12"))
	}
	for _, bad := range []string{"no-equals", "=regex", "name=", "bad=("} {
		if _, err := ParsePattern(bad); err == nil {
			t.Errorf("ParsePattern(%q): want error", bad)
		}
	}
}

func TestReadPatterns(t *testing.T) {
	ds, err := ReadPatterns(strings.NewReader("# custom ids\n\nmember=M-\\d{6}\npolicy = POL\\d+\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ds) != 2 || ds[0].Name != "member" || ds[1].Name != "policy" {
		t.Fatalf("got %+v", ds)
	}
	if _, err := ReadPatterns(strings.NewReader("ok=a\nbroken\n")); err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("err = %v, want line 2", err)
	}
}

func TestMask(t *testing.T) {
	for in, want := range map[string]string{
		"4111111111111111":     "41********11",
		"jane.doe@example.com": "ja********om",
		"abcdef":               "a****f",
		"abc":                  "***",
		"":                     "",
	} {
		if got := Mask(in); got != want {
			t.Errorf("Mask(%q) = %q, want %q", in, got, want)
		}
	}
}
