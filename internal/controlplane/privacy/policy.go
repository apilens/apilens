package privacy

import (
	"fmt"
	"regexp"
	"strings"
)

// Limits of one policy list.
const (
	// MaxPatterns bounds the patterns of each list.
	MaxPatterns = 50
	// MaxPatternLen bounds one pattern, in bytes.
	MaxPatternLen = 256
)

// Policy is the deny list of a project or of one of its apps: patterns on
// top of the built-in defaults.
type Policy struct {
	QueryParams []string
	Headers     []string
	BodyFields  []string
}

// InvalidPatternError names the first unusable pattern of a policy.
type InvalidPatternError struct {
	Field  string // mask_query_params, mask_headers or mask_body_fields
	Index  int
	Reason string
}

func (e *InvalidPatternError) Error() string {
	return fmt.Sprintf("%s[%d]: %s", e.Field, e.Index, e.Reason)
}

// Normalize trims every pattern, drops empty and duplicate ones and checks
// the rest compile as RE2 within the limits. It returns the cleaned policy
// or an *InvalidPatternError.
func (p Policy) Normalize() (Policy, error) {
	var out Policy
	var err error
	if out.QueryParams, err = normalizeList("mask_query_params", p.QueryParams); err != nil {
		return Policy{}, err
	}
	if out.Headers, err = normalizeList("mask_headers", p.Headers); err != nil {
		return Policy{}, err
	}
	if out.BodyFields, err = normalizeList("mask_body_fields", p.BodyFields); err != nil {
		return Policy{}, err
	}
	return out, nil
}

func normalizeList(field string, in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for i, raw := range in {
		pat := strings.TrimSpace(raw)
		if pat == "" || seen[pat] {
			continue
		}
		if len(pat) > MaxPatternLen {
			return nil, &InvalidPatternError{Field: field, Index: i, Reason: fmt.Sprintf("longer than %d bytes", MaxPatternLen)}
		}
		if _, err := regexp.Compile("(?i)" + pat); err != nil {
			return nil, &InvalidPatternError{Field: field, Index: i, Reason: "not a valid RE2 pattern"}
		}
		seen[pat] = true
		out = append(out, pat)
	}
	if len(out) > MaxPatterns {
		return nil, &InvalidPatternError{Field: field, Index: MaxPatterns, Reason: fmt.Sprintf("at most %d patterns", MaxPatterns)}
	}
	return out, nil
}
