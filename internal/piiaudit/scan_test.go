package piiaudit

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestScannerAggregates(t *testing.T) {
	s := NewScanner(DefaultDetectors())
	for range 3 {
		s.Scan(Record{Endpoint: "POST /users", Fields: []Field{
			{Name: "request_payload", Value: `{"email":"jane@example.com","card":"4111 1111 1111 1111"}`},
			{Name: "request_headers", Value: `{"content-type":"application/json"}`},
		}})
	}
	s.Scan(Record{Endpoint: "GET /users/{id}", Fields: []Field{
		{Name: "response_payload", Value: `{"email":"bob@example.com","ssn":"123-45-6789"}`},
	}})

	got := s.Findings()
	want := []Finding{
		{Endpoint: "POST /users", Field: "request_payload", Pattern: "card", Count: 3, Sample: "41********11"},
		{Endpoint: "POST /users", Field: "request_payload", Pattern: "email", Count: 3, Sample: "ja********om"},
		{Endpoint: "GET /users/{id}", Field: "response_payload", Pattern: "email", Count: 1, Sample: "bo********om"},
		{Endpoint: "GET /users/{id}", Field: "response_payload", Pattern: "us_ssn", Count: 1, Sample: "12*******89"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("findings:\n got %+v\nwant %+v", got, want)
	}
	if s.Records() != 4 {
		t.Fatalf("records = %d", s.Records())
	}
}

func TestScannerDoesNotDoubleCount(t *testing.T) {
	// The digits of an IBAN can pass Luhn, and a JWT can hold an email-like
	// run; each value is reported once, as the wider format.
	s := NewScanner(DefaultDetectors())
	s.Scan(Record{Endpoint: "POST /payouts", Fields: []Field{
		{Name: "request_payload", Value: `{"iban":"DE89 3704 0044 0532 0130 00"}`},
		{Name: "request_headers", Value: `{"authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MTExMTExMTExMTExMTExIn0.abc"}`},
	}})
	var patterns []string
	for _, f := range s.Findings() {
		patterns = append(patterns, f.Field+":"+f.Pattern)
	}
	slices.Sort(patterns)
	if want := []string{"request_headers:jwt", "request_payload:iban"}; !slices.Equal(patterns, want) {
		t.Fatalf("patterns = %q, want %q", patterns, want)
	}
}

func TestScannerDecodesRawPath(t *testing.T) {
	s := NewScanner(DefaultDetectors())
	s.Scan(Record{Endpoint: "GET /search", Fields: []Field{{Name: "raw_path", Value: "/search?q=jane%40example.com"}}})
	f := s.Findings()
	if len(f) != 1 || f[0].Pattern != "email" || f[0].Field != "raw_path" {
		t.Fatalf("findings = %+v", f)
	}
}

func TestScannerCleanData(t *testing.T) {
	s := NewScanner(DefaultDetectors())
	s.Scan(Record{Endpoint: "POST /users", Fields: []Field{
		{Name: "request_payload", Value: `{"email":"[redacted]","card":"[redacted]","count":1730000000}`},
		{Name: "raw_path", Value: "/users?page=2"},
	}})
	if f := s.Findings(); len(f) != 0 {
		t.Fatalf("findings = %+v, want none", f)
	}
}

func TestWriteTableAndJSON(t *testing.T) {
	findings := []Finding{{Endpoint: "POST /users", Field: "request_payload", Pattern: "email", Count: 2, Sample: "ja********om"}}
	var table bytes.Buffer
	if err := WriteTable(&table, findings); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(table.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "ENDPOINT") || strings.Join(strings.Fields(lines[1]), " ") != "POST /users request_payload email 2 ja********om" {
		t.Fatalf("table:\n%s", table.String())
	}
	var js bytes.Buffer
	if err := WriteJSON(&js, findings); err != nil {
		t.Fatal(err)
	}
	var back []Finding
	if err := json.Unmarshal(js.Bytes(), &back); err != nil || !slices.Equal(back, findings) {
		t.Fatalf("json %s: %v", js.String(), err)
	}
}

func TestScanCSV(t *testing.T) {
	in := "\ufeffTimestamp,Method,Path,Status_Code,raw_path,request_payload,consumer_name\n" +
		"2026-11-05T10:00:00Z,POST,/users,201,/users,\"{\"\"email\"\":\"\"jane@example.com\"\"}\",acme\n" +
		"2026-11-05T10:00:01Z,GET,/users/{id},200,/users/42?ref=4111111111111111,,bob@example.com\n"
	s := NewScanner(DefaultDetectors())
	if err := ScanCSV(strings.NewReader(in), s); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range s.Findings() {
		got = append(got, f.Endpoint+"|"+f.Field+"|"+f.Pattern)
	}
	slices.Sort(got)
	want := []string{
		"GET /users/{id}|consumer_name|email",
		"GET /users/{id}|raw_path|card",
		"POST /users|request_payload|email",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("findings = %q, want %q", got, want)
	}
	if s.Records() != 2 {
		t.Fatalf("records = %d", s.Records())
	}
}

func TestScanCSVErrors(t *testing.T) {
	for in, want := range map[string]string{
		"":                 "empty",
		"method,payload\n": "path or raw_path",
	} {
		err := ScanCSV(strings.NewReader(in), NewScanner(DefaultDetectors()))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("ScanCSV(%q) = %v, want %q", in, err, want)
		}
	}
}
