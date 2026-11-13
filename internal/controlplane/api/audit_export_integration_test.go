//go:build integration

package api

import (
	"encoding/csv"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/apilens/apilens/internal/identity/audit"
)

// exportAudit GETs an export as user and parses the CSV, failing on any
// status but 200.
func (f *auditFixture) exportAudit(t *testing.T, user, path string, query url.Values) ([][]string, http.Header) {
	t.Helper()
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	resp := f.api.Get(path, as(f.users[user]))
	if resp.Code != http.StatusOK {
		t.Fatalf("GET %s as %s: %d %s", path, user, resp.Code, resp.Body)
	}
	if ct := resp.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("Content-Type = %q", ct)
	}
	if cd := resp.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment; filename=") {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	rows, err := csv.NewReader(resp.Body).ReadAll()
	if err != nil {
		t.Fatalf("parse CSV: %v", err)
	}
	if len(rows) == 0 || !slices.Equal(rows[0], auditCSVColumns) {
		t.Fatalf("header = %v", rows)
	}
	return rows[1:], resp.Header()
}

func TestProjectAuditExport(t *testing.T) {
	f := setupAuditEvents(t)
	owner := f.users["owner"]
	tricky := []string{`=HYPERLINK("http://evil.example","x")`, "+1", "-2+3", "@SUM(A1)", "Comma, \"quoted\"\nnewline"}
	ctx := audit.WithRequest(f.ctx, audit.Request{UserAgent: "export-agent", ID: "req-2"})
	for i, label := range tricky {
		if err := audit.New(f.pool).Record(ctx, audit.Event{Actor: &owner, Kind: audit.AppRenamed, Org: &f.org, Project: &f.project,
			Target:  audit.Target{Type: "app", ID: "t" + string(rune('a'+i)), Label: label},
			Changes: &audit.Changes{Previous: map[string]any{"name": "old"}, Next: map[string]any{"name": label}}}); err != nil {
			t.Fatal(err)
		}
	}
	path := ProjectsPath + "/shop/audit-events/export"
	want := f.count(t, `SELECT count(*) FROM audit_events WHERE project_id = $1`, f.project)
	var email string
	if err := f.pool.QueryRow(f.ctx, `SELECT email::text FROM users WHERE id = $1`, owner).Scan(&email); err != nil {
		t.Fatal(err)
	}

	rows, h := f.exportAudit(t, "owner", path, url.Values{"format": {"csv"}})
	if len(rows) != want || h.Get(TruncatedHeader) != "" {
		t.Fatalf("rows = %d (want %d), truncated %q", len(rows), want, h.Get(TruncatedHeader))
	}
	col := func(name string) int { return slices.Index(auditCSVColumns, name) }
	labels := map[string][]string{}
	for _, r := range rows {
		if len(r) != len(auditCSVColumns) {
			t.Fatalf("row width %d: %v", len(r), r)
		}
		if r[col("project")] != "shop" {
			t.Fatalf("project = %q", r[col("project")])
		}
		labels[r[col("target_label")]] = r
	}
	// The injection guard: every cell starting with = + - @ gets a quote,
	// and CSV quoting round-trips commas, quotes and newlines.
	for _, label := range tricky {
		wantLabel := label
		if strings.ContainsAny(label[:1], "=+-@") {
			wantLabel = "'" + label
		}
		r, ok := labels[wantLabel]
		if !ok {
			t.Fatalf("no row with target_label %q in %v", wantLabel, labels)
		}
		if r[col("action")] != "app.renamed" || r[col("actor_id")] != owner.String() || r[col("actor_email")] != email ||
			r[col("actor_name")] == "" || r[col("user_agent")] != "export-agent" || r[col("request_id")] != "req-2" ||
			r[col("previous")] != `{"name":"old"}` || !strings.HasPrefix(r[col("next")], `{"name":`) {
			t.Fatalf("row = %v", r)
		}
	}
	if r := labels["'-2+3"]; r[col("next")] != `{"name":"-2+3"}` {
		t.Fatalf("next = %q", r[col("next")])
	}
	// A system event has no actor.
	if r := labels["Web"]; r[col("actor_id")] != "" || r[col("actor_email")] != "" || r[col("action")] != "app.created" {
		t.Fatalf("system row = %v", r)
	}

	// Filters apply as on the list.
	if rows, _ := f.exportAudit(t, "owner", path, url.Values{"action": {"api_key."}}); len(rows) != 5 {
		t.Fatalf("api_key. rows = %d", len(rows))
	}

	// The export is audited, with its filters and size, and is not part of
	// itself.
	var n int
	if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM audit_events WHERE event = 'audit_log.exported' AND project_id = $1
		AND actor_user_id = $2 AND org_id = $3 AND metadata->>'format' = 'csv' AND metadata->'filters'->>'action' = 'api_key.'
		AND (metadata->>'rows')::int = 5 AND metadata->>'truncated' = 'false'`, f.project, owner, f.org).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("audit_log.exported with filters recorded %d times", n)
	}

	// view_audit only.
	f.grant(t, "viewer2", "editor")
	for _, u := range []string{"member", "viewer", "viewer2"} {
		if code, body := f.getAudit(u, path, nil); code != http.StatusForbidden {
			t.Errorf("%s: %d %s", u, code, body)
		}
	}
	if code, _ := f.getAudit("stranger", path, nil); code != http.StatusNotFound {
		t.Errorf("stranger: %d", code)
	}
	if code, _ := f.getAudit("owner", path, url.Values{"format": {"xlsx"}}); code != http.StatusUnprocessableEntity && code != http.StatusBadRequest {
		t.Errorf("format=xlsx: %d", code)
	}
}

func TestOrgAuditExport(t *testing.T) {
	f := setupAuditEvents(t)
	path := OrgsPath + "/acme/audit-events/export"
	rows, _ := f.exportAudit(t, "admin", path, nil)
	col := func(name string) int { return slices.Index(auditCSVColumns, name) }
	var orgWide, shop int
	for _, r := range rows {
		switch {
		case r[col("target_label")] == "Hidden":
			t.Fatal("event of a project the caller cannot view exported")
		case r[col("project")] == "":
			orgWide++
		case r[col("project")] == "shop":
			shop++
		default:
			t.Fatalf("row with project %q", r[col("project")])
		}
	}
	if orgWide == 0 || shop != f.count(t, `SELECT count(*) FROM audit_events WHERE project_id = $1`, f.project) {
		t.Fatalf("org export: %d org-wide, %d shop rows", orgWide, shop)
	}
	if f.count(t, `SELECT count(*) FROM audit_events WHERE event = 'audit_log.exported' AND org_id = $1 AND project_id IS NULL AND actor_user_id = $2`,
		f.org, f.users["admin"]) != 1 {
		t.Fatal("org export not audited")
	}
	for _, u := range []string{"member", "viewer"} {
		if code, body := f.getAudit(u, path, nil); code != http.StatusForbidden {
			t.Errorf("%s: %d %s", u, code, body)
		}
	}
}

// TestAuditExportCap streams 100 001 matching events: the file holds the
// newest 100 000 and says it was truncated.
func TestAuditExportCap(t *testing.T) {
	if testing.Short() {
		t.Skip("inserts 100 001 audit events")
	}
	f := setupAuditEvents(t)
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO audit_events (event, user_agent, metadata, org_id, project_id, target_type, target_id, target_label, created_at)
		SELECT 'app.renamed', 'bulk', '{}', $1, $2, 'app', g::text, 'bulk-' || g, now() - make_interval(secs => g)
		FROM generate_series(1, $3::int) g`, f.org, f.project, audit.MaxExportRows+1); err != nil {
		t.Fatal(err)
	}
	rows, h := f.exportAudit(t, "owner", ProjectsPath+"/shop/audit-events/export", url.Values{"action": {"app.renamed"}})
	if len(rows) != audit.MaxExportRows || h.Get(TruncatedHeader) != "true" {
		t.Fatalf("rows = %d, truncated %q", len(rows), h.Get(TruncatedHeader))
	}
	col := slices.Index(auditCSVColumns, "target_id")
	if rows[0][col] != "1" || rows[len(rows)-1][col] != "100000" {
		t.Fatalf("first %q, last %q: not the newest, in order", rows[0][col], rows[len(rows)-1][col])
	}
}
