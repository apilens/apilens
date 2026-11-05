package piiaudit

import (
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"text/tabwriter"
)

// Field is one captured value of a record, such as its raw_path or its
// request_payload.
type Field struct {
	Name  string
	Value string
}

// Record is one captured request: the endpoint it belongs to and the values
// to scan.
type Record struct {
	Endpoint string // "METHOD /path/{template}"
	Fields   []Field
}

// Finding counts the matches of one pattern in one field of one endpoint.
// Sample is the first match, masked.
type Finding struct {
	Endpoint string `json:"endpoint"`
	Field    string `json:"field"`
	Pattern  string `json:"pattern"`
	Count    int    `json:"count"`
	Sample   string `json:"sample"`
}

type findingKey struct{ endpoint, field, pattern string }

// Scanner aggregates detector matches over records.
type Scanner struct {
	detectors []Detector
	findings  map[findingKey]*Finding
	records   int
}

// NewScanner returns a scanner running detectors in order.
func NewScanner(detectors []Detector) *Scanner {
	return &Scanner{detectors: detectors, findings: map[findingKey]*Finding{}}
}

// Scan adds the matches in r.
func (s *Scanner) Scan(r Record) {
	s.records++
	for _, f := range r.Fields {
		value := f.Value
		if f.Name == "raw_path" {
			// Query strings arrive percent-encoded (user%40example.com).
			if u, err := url.QueryUnescape(value); err == nil {
				value = u
			}
		}
		for _, d := range s.detectors {
			locs := d.find(value)
			if len(locs) == 0 {
				continue
			}
			k := findingKey{r.Endpoint, f.Name, d.Name}
			fd := s.findings[k]
			if fd == nil {
				fd = &Finding{Endpoint: r.Endpoint, Field: f.Name, Pattern: d.Name, Sample: Mask(value[locs[0][0]:locs[0][1]])}
				s.findings[k] = fd
			}
			fd.Count += len(locs)
			value = blank(value, locs)
		}
	}
}

// blank replaces each located match with spaces, so later detectors do not
// match inside it.
func blank(s string, locs [][]int) string {
	var b strings.Builder
	prev := 0
	for _, loc := range locs {
		b.WriteString(s[prev:loc[0]])
		b.WriteString(strings.Repeat(" ", loc[1]-loc[0]))
		prev = loc[1]
	}
	b.WriteString(s[prev:])
	return b.String()
}

// Records returns how many records were scanned.
func (s *Scanner) Records() int { return s.records }

// Findings returns the findings, most frequent first.
func (s *Scanner) Findings() []Finding {
	out := make([]Finding, 0, len(s.findings))
	for _, f := range s.findings {
		out = append(out, *f)
	}
	slices.SortFunc(out, func(a, b Finding) int {
		return cmp.Or(cmp.Compare(b.Count, a.Count), cmp.Compare(a.Endpoint, b.Endpoint),
			cmp.Compare(a.Field, b.Field), cmp.Compare(a.Pattern, b.Pattern))
	})
	return out
}

// WriteTable prints findings as an aligned table.
func WriteTable(w io.Writer, findings []Finding) error {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "ENDPOINT\tFIELD\tPATTERN\tCOUNT\tSAMPLE")
	for _, f := range findings {
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%d\t%s\n", f.Endpoint, f.Field, f.Pattern, f.Count, f.Sample)
	}
	return tw.Flush()
}

// WriteJSON prints findings as one JSON array.
func WriteJSON(w io.Writer, findings []Finding) error {
	return json.NewEncoder(w).Encode(findings)
}
