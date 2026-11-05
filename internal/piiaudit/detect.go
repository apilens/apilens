// Package piiaudit scans captured request data for values that look like
// personal data: emails, card numbers, IBANs, JWTs and national ids. It backs
// `apilens pii-audit`, the gate a third-party rollout must pass ("zero hits")
// before it is promoted to the redacted capture posture.
//
// Detectors match values, not field names, so they catch PII that slipped
// past name-based masking (an email in a free-text field, a card number in a
// query string).
package piiaudit

import (
	"bufio"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"strings"
)

// Detector finds one kind of PII in a value. Re finds candidates; Valid, when
// set, rejects candidates that fail a checksum or a format rule.
type Detector struct {
	Name  string
	Re    *regexp.Regexp
	Valid func(match string) bool
}

// Find returns the matches of d in s that pass its validation.
func (d Detector) Find(s string) []string {
	locs := d.find(s)
	out := make([]string, 0, len(locs))
	for _, loc := range locs {
		out = append(out, s[loc[0]:loc[1]])
	}
	return out
}

func (d Detector) find(s string) [][]int {
	var out [][]int
	for _, loc := range d.Re.FindAllStringIndex(s, -1) {
		if d.Valid == nil || d.Valid(s[loc[0]:loc[1]]) {
			out = append(out, loc)
		}
	}
	return out
}

// DefaultDetectors returns the built-in detectors. The scanner runs them in
// this order and blanks each match before the next one runs, so the wider
// formats come first: the digits inside a JWT or an IBAN are not reported
// again as a card number.
func DefaultDetectors() []Detector {
	return []Detector{
		// header.payload.signature where header and payload are base64url JSON objects.
		{Name: "jwt", Re: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*`)},
		{Name: "email", Re: regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`)},
		{Name: "iban", Re: regexp.MustCompile(`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b`), Valid: validIBAN},
		// 13–19 digits, optionally grouped with spaces or dashes.
		{Name: "card", Re: regexp.MustCompile(`\b\d(?:[ -]?\d){12,18}\b`), Valid: validCard},
		{Name: "us_ssn", Re: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), Valid: validSSN},
		{Name: "uk_nino", Re: regexp.MustCompile(`\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b`), Valid: validNINO},
		{Name: "in_pan", Re: regexp.MustCompile(`\b[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]\b`)},
	}
}

func digitsOf(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// validCard reports whether s holds 13–19 digits passing the Luhn check.
// Runs of one repeated digit (0000…) pass Luhn but are never real cards.
func validCard(s string) bool {
	d := digitsOf(s)
	if len(d) < 13 || len(d) > 19 || strings.Count(d, d[:1]) == len(d) {
		return false
	}
	return luhn(d)
}

func luhn(digits string) bool {
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		n := int(digits[i] - '0')
		if double {
			if n *= 2; n > 9 {
				n -= 9
			}
		}
		sum += n
		double = !double
	}
	return sum%10 == 0
}

// validIBAN applies the ISO 13616 mod-97 check.
func validIBAN(s string) bool {
	s = strings.ReplaceAll(s, " ", "")
	if len(s) < 15 || len(s) > 34 {
		return false
	}
	var b strings.Builder
	for _, r := range s[4:] + s[:4] {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			_, _ = fmt.Fprintf(&b, "%d", r-'A'+10)
		default:
			return false
		}
	}
	n, ok := new(big.Int).SetString(b.String(), 10)
	return ok && new(big.Int).Mod(n, big.NewInt(97)).Int64() == 1
}

// validSSN rejects numbers the SSA never issues: area 000, 666 or 9xx,
// group 00 and serial 0000.
func validSSN(s string) bool {
	area, group, serial := s[0:3], s[4:6], s[7:11]
	return area != "000" && area != "666" && area[0] != '9' && group != "00" && serial != "0000"
}

// validNINO rejects the prefixes HMRC never allocates.
func validNINO(s string) bool {
	switch s[:2] {
	case "BG", "GB", "KN", "NK", "NT", "TN", "ZZ":
		return false
	}
	return true
}

// ParsePattern parses a custom detector written as name=regex.
func ParsePattern(spec string) (Detector, error) {
	name, expr, ok := strings.Cut(spec, "=")
	name, expr = strings.TrimSpace(name), strings.TrimSpace(expr)
	if !ok || name == "" || expr == "" {
		return Detector{}, fmt.Errorf("pattern %q: want name=regex", spec)
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return Detector{}, fmt.Errorf("pattern %q: %w", name, err)
	}
	return Detector{Name: name, Re: re}, nil
}

// ReadPatterns parses a patterns file: one name=regex per line; blank lines
// and lines starting with # are ignored.
func ReadPatterns(r io.Reader) ([]Detector, error) {
	var out []Detector
	sc := bufio.NewScanner(r)
	for line := 1; sc.Scan(); line++ {
		text := strings.TrimSpace(sc.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		d, err := ParsePattern(text)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		out = append(out, d)
	}
	return out, sc.Err()
}

// Mask hides most of a matched value so the report can be shared: it keeps
// at most two characters at each end and caps the hidden run at eight stars.
func Mask(s string) string {
	r := []rune(s)
	keep := min(2, len(r)/4)
	hidden := min(len(r)-2*keep, 8)
	return string(r[:keep]) + strings.Repeat("*", hidden) + string(r[len(r)-keep:])
}
