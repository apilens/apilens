// Package privacy is the server-side privacy policy: the deny list the ingest
// edge applies to every record before it is stored, as the second line of
// defence behind the SDKs' own masking. A policy names query parameters,
// headers and JSON body fields by case-insensitive RE2 pattern; their values
// are replaced with "[redacted]", names stay visible.
//
// The built-in defaults (the SDKs' default masking lists) always apply; a
// project's policy and its apps' policies only add patterns, never remove
// them.
package privacy

import (
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

// Redacted replaces every masked value.
const Redacted = "[redacted]"

// Built-in patterns, matched case-insensitively against names. They are the
// SDKs' default masking lists (Apitally parity) and are applied always.
var (
	DefaultQueryParams = []string{`auth`, `api.?key`, `secret`, `token`, `password`, `pwd`}
	DefaultHeaders     = []string{`auth`, `api.?key`, `secret`, `token`, `cookie`}
	DefaultBodyFields  = []string{`password`, `pwd`, `token`, `secret`, `auth`, `card.?number`, `ccv`, `cvv`, `cvc`, `ssn`}
)

// SensitiveHeaders are header names (lower case) whose values are always
// replaced, matched exactly; the same set as the SDKs' SENSITIVE_HEADERS.
var SensitiveHeaders = []string{
	"authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key",
	"api-key", "x-auth-token", "x-amz-security-token", "x-csrf-token",
}

// maxBodyDepth bounds how deep a JSON body is walked (adversarially deep
// documents); the SDKs use the same limit.
const maxBodyDepth = 32

// Redactor is a compiled policy. It is immutable and safe for concurrent use.
type Redactor struct {
	query   *regexp.Regexp
	headers *regexp.Regexp
	body    *regexp.Regexp
	// text matches the key of a key=value pair in free text (log messages,
	// bodies that are not JSON): any of the three lists.
	text  *regexp.Regexp
	exact map[string]bool
}

// Default is the redactor of the built-in defaults alone.
var Default = mustCompile()

func mustCompile(ps ...Policy) *Redactor {
	r, err := Compile(ps...)
	if err != nil {
		panic(err)
	}
	return r
}

// Compile builds the redactor of the defaults plus every policy in ps.
// Patterns must be valid RE2 (Policy.Validate checks them one by one).
func Compile(ps ...Policy) (*Redactor, error) {
	query, headers, body := slices.Clone(DefaultQueryParams), slices.Clone(DefaultHeaders), slices.Clone(DefaultBodyFields)
	for _, p := range ps {
		query = append(query, p.QueryParams...)
		headers = append(headers, p.Headers...)
		body = append(body, p.BodyFields...)
	}
	r := &Redactor{exact: make(map[string]bool, len(SensitiveHeaders))}
	for _, h := range SensitiveHeaders {
		r.exact[h] = true
	}
	var err error
	if r.query, err = union(query); err != nil {
		return nil, err
	}
	if r.headers, err = union(headers); err != nil {
		return nil, err
	}
	if r.body, err = union(body); err != nil {
		return nil, err
	}
	if r.text, err = union(slices.Concat(query, headers, body)); err != nil {
		return nil, err
	}
	return r, nil
}

// union compiles patterns into one case-insensitive alternation, so a name is
// matched with a single scan however many patterns there are.
func union(patterns []string) (*regexp.Regexp, error) {
	seen := make(map[string]bool, len(patterns))
	parts := make([]string, 0, len(patterns))
	for _, p := range patterns {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		parts = append(parts, "(?:"+p+")")
	}
	return regexp.Compile("(?i)" + strings.Join(parts, "|"))
}

// HeaderMatches reports whether the value of the header name must be masked.
func (r *Redactor) HeaderMatches(name string) bool {
	return r.exact[strings.ToLower(name)] || r.headers.MatchString(name)
}

// RawPath masks the values of matching query parameters in a path with an
// optional query string ("/orders?token=abc" -> "/orders?token=[redacted]").
// Everything else, the encoding of the other parameters included, is kept.
func (r *Redactor) RawPath(s string) string {
	i := strings.IndexByte(s, '?')
	if i < 0 {
		return s
	}
	q, frag := s[i+1:], ""
	if j := strings.IndexByte(q, '#'); j >= 0 {
		q, frag = q[:j], q[j:]
	}
	if masked, changed := r.Query(q); changed {
		return s[:i+1] + masked + frag
	}
	return s
}

// Query masks the values of matching parameters in a raw query string and
// reports whether anything changed.
func (r *Redactor) Query(q string) (string, bool) {
	if q == "" {
		return q, false
	}
	parts := strings.Split(q, "&")
	changed := false
	for i, part := range parts {
		k, v, ok := strings.Cut(part, "=")
		if !ok || v == Redacted {
			continue
		}
		name, err := url.QueryUnescape(k)
		if err != nil {
			name = k
		}
		if r.query.MatchString(name) {
			parts[i], changed = k+"="+Redacted, true
		}
	}
	if !changed {
		return q, false
	}
	return strings.Join(parts, "&"), true
}

// quotedRedacted is Redacted as a JSON string.
const quotedRedacted = `"` + Redacted + `"`

// Headers masks matching values in a captured header JSON object
// ({"name": "value", ...}); the value is replaced whatever its type. Header
// text that is not a JSON object is masked as free text (see Text). Only the
// masked values change: key order and formatting are kept, and an unchanged
// object is returned as is.
func (r *Redactor) Headers(s string) string {
	if s == "" {
		return s
	}
	if !looksLike(s, '{') || !json.Valid([]byte(s)) {
		return r.Text(s)
	}
	return maskJSON(s, r.HeaderMatches, true)
}

// Body masks the string and number values of matching fields in a JSON body,
// at any depth; objects and arrays under a matching field are walked, not
// replaced. A body that is not JSON (form-encoded, plain text, or JSON the
// SDK truncated) is masked as free text instead (see Text). Only the masked
// values change: key order and formatting are kept.
func (r *Redactor) Body(s string) string {
	if s == "" {
		return s
	}
	if (!looksLike(s, '{') && !looksLike(s, '[')) || !json.Valid([]byte(s)) {
		return r.Text(s)
	}
	return maskJSON(s, r.body.MatchString, false)
}

// maskJSON replaces, in the valid JSON document s, the values of object
// members whose key satisfies match. With topOnly (headers) only the members
// of the top-level object are considered and any value is replaced;
// otherwise members up to maxBodyDepth are, and only string and number
// values are replaced (containers are walked). It scans the bytes once
// without building a tree, so the cost is linear in len(s) and independent
// of how values are typed.
func maskJSON(s string, match func(string) bool, topOnly bool) string {
	var (
		b        strings.Builder
		last     int
		stack    = make([]byte, 0, 16) // '{' or '['
		wantKey  bool                  // the next string in the current object is a key
		verdicts = map[string]bool{}   // keys repeat a lot in arrays of objects
	)
	matches := func(key string) bool {
		v, ok := verdicts[key]
		if !ok {
			v = match(key)
			verdicts[key] = v
		}
		return v
	}
	for i := 0; i < len(s); {
		switch c := s[i]; c {
		case '{', '[':
			stack = append(stack, c)
			wantKey = c == '{'
			i++
		case '}', ']':
			stack = stack[:len(stack)-1]
			wantKey = false
			i++
		case ',':
			wantKey = len(stack) > 0 && stack[len(stack)-1] == '{'
			i++
		case '"':
			end := stringEnd(s, i)
			if !wantKey {
				i = end
				continue
			}
			wantKey = false
			// The value starts after the colon.
			j := skipSpace(s, end)
			j = skipSpace(s, j+1)
			considered := len(stack) <= maxBodyDepth+1 && (!topOnly || len(stack) == 1)
			if !considered || !matches(unquote(s[i:end])) {
				i = j
				continue
			}
			var vend int
			switch {
			case topOnly:
				vend = valueEnd(s, j)
			case s[j] == '"':
				vend = stringEnd(s, j)
			case s[j] == '-' || (s[j] >= '0' && s[j] <= '9'):
				vend = numberEnd(s, j)
			default: // object, array, true, false, null: walk on
				i = j
				continue
			}
			if s[j:vend] != quotedRedacted {
				if b.Len() == 0 {
					b.Grow(len(s))
				}
				b.WriteString(s[last:j])
				b.WriteString(quotedRedacted)
				last = vend
			}
			i = vend
		default:
			i++
		}
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

// stringEnd returns the index after the JSON string starting at s[i] == '"'.
func stringEnd(s string, i int) int {
	for j := i + 1; j < len(s); j++ {
		switch s[j] {
		case '\\':
			j++
		case '"':
			return j + 1
		}
	}
	return len(s)
}

func numberEnd(s string, i int) int {
	for i < len(s) && strings.IndexByte("+-.eE0123456789", s[i]) >= 0 {
		i++
	}
	return i
}

// valueEnd returns the index after the JSON value starting at s[i].
func valueEnd(s string, i int) int {
	switch s[i] {
	case '"':
		return stringEnd(s, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(s); j++ {
			switch s[j] {
			case '"':
				j = stringEnd(s, j) - 1
			case '{', '[':
				depth++
			case '}', ']':
				if depth--; depth == 0 {
					return j + 1
				}
			}
		}
		return len(s)
	default: // number, true, false, null
		j := i
		for j < len(s) && strings.IndexByte(" \t\r\n,}]", s[j]) < 0 {
			j++
		}
		return j
	}
}

func skipSpace(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n') {
		i++
	}
	return i
}

// unquote decodes a JSON string token; escapes are rare in keys, so the
// common case does not allocate.
func unquote(tok string) string {
	inner := tok[1 : len(tok)-1]
	if strings.IndexByte(inner, '\\') < 0 {
		return inner
	}
	var out string
	if err := json.Unmarshal([]byte(tok), &out); err != nil {
		return inner
	}
	return out
}

// kv finds key=value and key: value pairs in free text, "key": "value" in
// JSON fragments included. The value may be quoted or carry an auth scheme
// ("Authorization: Bearer abc").
var kv = regexp.MustCompile(`([A-Za-z_][A-Za-z0-9_.\-]*)("?\s*[=:]\s*)((?i:(?:bearer|basic|token|digest)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&"'<>{}\[\]]+))`)

// Text masks the values of key=value pairs whose key matches any of the
// policy's query, header or body patterns in free text such as a log
// message ("login failed for token=abc" -> "login failed for token=[redacted]").
// A pair whose key does not match is searched again from its value, so
// "failed: token=abc" still finds token.
func (r *Redactor) Text(s string) string {
	var b strings.Builder
	last, pos := 0, 0
	for pos < len(s) {
		m := kv.FindStringSubmatchIndex(s[pos:])
		if m == nil {
			break
		}
		for k := range m {
			m[k] += pos
		}
		key, value := s[m[2]:m[3]], s[m[6]:m[7]]
		if value == Redacted || value == quotedRedacted || (!r.exact[strings.ToLower(key)] && !r.text.MatchString(key)) {
			pos = m[6]
			continue
		}
		if b.Len() == 0 {
			b.Grow(len(s))
		}
		b.WriteString(s[last:m[6]])
		if strings.HasPrefix(value, `"`) {
			b.WriteString(quotedRedacted)
		} else {
			b.WriteString(Redacted)
		}
		last, pos = m[7], m[7]
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}

func looksLike(s string, open byte) bool {
	s = strings.TrimLeft(s, " \t\r\n")
	return s != "" && s[0] == open
}
