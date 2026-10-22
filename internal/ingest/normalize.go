package ingest

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Limits mirror the v1 ingest service so SDK behaviour does not change.
const (
	maxPayloadChars        = 65_536
	maxLogMessageChars     = 8_192
	maxLogPayloadChars     = 16_384
	maxAttributeKeyChars   = 64
	maxAttributeValueChars = 512
	maxAttributes          = 64
	maxReleaseChars        = 128
	maxCommitChars         = 64
	maxShortFieldChars     = 1_024 // method, paths, names, user agents, ...
	traceIDHexLen          = 32
	spanIDHexLen           = 16
	defaultEnvironment     = "production"
	maxEnvironmentChars    = 64
	maxFutureSkew          = 24 * time.Hour
)

// truncate cuts s to at most n runes without splitting a UTF-8 sequence and
// replaces invalid UTF-8 (ClickHouse String accepts bytes, the dashboard
// expects text).
func truncate(s string, n int) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	if len(s) <= n { // byte length bounds rune length
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

func short(s string) string { return truncate(strings.TrimSpace(s), maxShortFieldChars) }

// hexID accepts only a well-formed, non-zero lowercase hex id of the given
// length (W3C Trace Context); anything else becomes "".
func hexID(s string, length int) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != length || strings.Count(s, "0") == length {
		return ""
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return ""
		}
	}
	return s
}

func environment(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return defaultEnvironment
	}
	return truncate(s, maxEnvironmentChars)
}

var logLevels = map[string]string{
	"TRACE": "DEBUG", "DEBUG": "DEBUG", "INFO": "INFO", "NOTICE": "INFO",
	"WARN": "WARNING", "WARNING": "WARNING", "ERROR": "ERROR",
	"CRITICAL": "CRITICAL", "FATAL": "CRITICAL",
}

func logLevel(s string) string {
	if lvl, ok := logLevels[strings.ToUpper(strings.TrimSpace(s))]; ok {
		return lvl
	}
	return "INFO"
}

func release(s string) string { return truncate(strings.TrimSpace(s), maxReleaseChars) }
func commit(s string) string  { return truncate(strings.TrimSpace(s), maxCommitChars) }

func clampStatus(code int) uint16 {
	if code < 0 || code > 999 {
		return 0
	}
	return uint16(code)
}

func nonNegative(f float64) float64 {
	if f < 0 || f != f { // negative or NaN
		return 0
	}
	return f
}

func sizeOf(n int64) uint64 {
	if n < 0 {
		return 0
	}
	return uint64(n)
}

// attributes flattens a JSON object into bounded string pairs.
func attributes(in map[string]json.RawMessage) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, min(len(in), maxAttributes))
	for k, raw := range in {
		if len(out) >= maxAttributes {
			break
		}
		key := truncate(strings.TrimSpace(k), maxAttributeKeyChars)
		if key == "" {
			continue
		}
		// Like v1, nested objects/arrays are dropped rather than flattened.
		if t := firstNonSpace(raw); t == '{' || t == '[' {
			continue
		}
		out[key] = truncate(rawToString(raw), maxAttributeValueChars)
	}
	return out
}

func firstNonSpace(b []byte) byte {
	for _, c := range b {
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			return c
		}
	}
	return 0
}

func rawToString(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	if string(raw) == "null" {
		return ""
	}
	return string(raw) // numbers and bools keep their JSON text
}

// flexTime parses the timestamp formats SDKs send: RFC 3339 with or without
// offset (naive values are UTC, matching v1), or Unix seconds.
type flexTime struct{ time.Time }

func (t *flexTime) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	if len(b) > 0 && b[0] != '"' {
		f, err := strconv.ParseFloat(string(b), 64)
		if err != nil {
			return fmt.Errorf("invalid timestamp %s", b)
		}
		sec := int64(f)
		t.Time = time.Unix(sec, int64((f-float64(sec))*1e9)).UTC()
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	parsed, err := parseTime(s)
	if err != nil {
		return err
	}
	t.Time = parsed
	return nil
}

var naiveLayouts = []string{
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
}

func parseTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	if ts, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return ts.UTC(), nil
	}
	// Python's isoformat() with a space separator and offset.
	if ts, err := time.Parse("2006-01-02 15:04:05.999999999Z07:00", s); err == nil {
		return ts.UTC(), nil
	}
	for _, layout := range naiveLayouts {
		if ts, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return ts, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid timestamp %q", s)
}

// validTimestamp rejects zero values and timestamps implausibly far in the
// future (clock-skewed or malicious clients).
func validTimestamp(ts time.Time, now time.Time) bool {
	return !ts.IsZero() && ts.Before(now.Add(maxFutureSkew)) && ts.Year() >= 2000
}
