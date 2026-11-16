package purge

import (
	"io/fs"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/apilens/apilens/internal/migrations"
)

var (
	createTableRE = regexp.MustCompile(`(?is)CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\)\s*ENGINE`)
	addColumnRE   = regexp.MustCompile(`(?is)ALTER TABLE\s+(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+project_id\b`)
	dropTableRE   = regexp.MustCompile(`(?i)DROP TABLE IF EXISTS\s+(\w+)`)
	mvRE          = regexp.MustCompile(`(?is)CREATE MATERIALIZED VIEW IF NOT EXISTS\s+(\w+)(\s+TO\s+\w+)?`)
	projectColRE  = regexp.MustCompile(`(?m)^\s*project_id\s`)
)

// clickHouseProjectTables reads every ClickHouse migration's Up section and
// returns the tables that end up with a project_id column.
func clickHouseProjectTables(t *testing.T) []string {
	t.Helper()
	files, err := fs.Glob(migrations.ClickHouseFS(), "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("no ClickHouse migrations found")
	}
	tables := map[string]bool{}
	for _, f := range files {
		b, err := fs.ReadFile(migrations.ClickHouseFS(), f)
		if err != nil {
			t.Fatal(err)
		}
		up := string(b)
		if i := strings.Index(up, "-- +goose Down"); i >= 0 {
			up = up[:i]
		}
		for _, m := range createTableRE.FindAllStringSubmatch(up, -1) {
			if projectColRE.MatchString(m[2]) {
				tables[m[1]] = true
			}
		}
		for _, m := range addColumnRE.FindAllStringSubmatch(up, -1) {
			tables[m[1]] = true
		}
		for _, m := range dropTableRE.FindAllStringSubmatch(up, -1) {
			delete(tables, m[1])
		}
		for _, m := range mvRE.FindAllStringSubmatch(up, -1) {
			// A view without TO keeps its rows in a hidden inner table the
			// purge cannot name; every view must write to a listed table.
			if m[2] == "" {
				t.Errorf("%s: materialized view %s has no TO table; write to a table in ClickHouseTables instead", f, m[1])
			}
		}
	}
	out := make([]string, 0, len(tables))
	for name := range tables {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

// TestClickHouseTablesCoverEveryProjectTable fails when a ClickHouse table
// with a project_id column is missing from ClickHouseTables, so a new
// telemetry table cannot be forgotten by the purge.
func TestClickHouseTablesCoverEveryProjectTable(t *testing.T) {
	found := clickHouseProjectTables(t)
	if len(found) == 0 {
		t.Fatal("no ClickHouse table with a project_id column found; the migration parser is broken")
	}
	for _, name := range found {
		if !slices.Contains(ClickHouseTables, name) {
			t.Errorf("ClickHouse table %s has a project_id column but is not in purge.ClickHouseTables", name)
		}
	}
	for _, name := range ClickHouseTables {
		if !slices.Contains(found, name) {
			t.Errorf("purge.ClickHouseTables lists %s, which no migration creates with a project_id column", name)
		}
	}
}

func TestStepsRunInOrder(t *testing.T) {
	var got []string
	for s := stepClickHouse; s != stepDone; s = nextStep(s) {
		got = append(got, s)
	}
	want := []string{stepClickHouse, stepValkey, stepFiles, stepPostgres}
	if !slices.Equal(got, want) {
		t.Fatalf("steps = %v, want %v", got, want)
	}
	if nextStep("bogus") != stepDone {
		t.Fatal("an unknown step must not loop")
	}
}

func TestNamesAny(t *testing.T) {
	project := "6f1c2a3e-0d4b-4c5e-9f8a-1b2c3d4e5f60"
	app := "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e"
	ids := []string{project, app}
	for key, want := range map[string]bool{
		"apilens:ingest:usage:" + project + ":2026-11-13":           true,
		"apilens:ingest:stats:" + app + ":2026-11-13":               true,
		"apilens:app:last_seen:" + app + ":production":              true,
		"apilens:ingest:quota:rpm:" + project:                       true,
		"apilens:ingest:usage:11111111-2222-4333-8444-555555555555": false,
		"apilens:authz:token":                                       false,
	} {
		if got := NamesAny(key, ids); got != want {
			t.Errorf("NamesAny(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestDeleteStatement(t *testing.T) {
	if got, want := DeleteStatement("api_logs"), "ALTER TABLE api_logs DELETE WHERE project_id = ?"; got != want {
		t.Fatalf("DeleteStatement = %q, want %q", got, want)
	}
}
