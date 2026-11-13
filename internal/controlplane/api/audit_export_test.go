package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"runtime"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/auditlog"
	"github.com/apilens/apilens/internal/identity/audit"
)

func TestCSVSafe(t *testing.T) {
	for in, want := range map[string]string{
		"":             "",
		"Key-1":        "Key-1",
		"=1+2":         "'=1+2",
		"+1":           "'+1",
		"-1":           "'-1",
		"@SUM(A1)":     "'@SUM(A1)",
		"\t=1":         "'\t=1",
		"\r=1":         "'\r=1",
		"a=1":          "a=1",
		`{"name":"x"}`: `{"name":"x"}`,
	} {
		if got := csvSafe(in); got != want {
			t.Errorf("csvSafe(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWriteAuditCSV(t *testing.T) {
	actor := uuid.New()
	at := time.Date(2026, 11, 13, 10, 0, 0, 123000000, time.UTC)
	entries := []auditlog.Entry{
		{Entry: audit.Entry{ID: 2, Time: at, Kind: "app.renamed", Actor: &actor, ActorLabel: "Ada, \"the\" admin", ActorEmail: "ada@example.com",
			IP: "203.0.113.7", UserAgent: "agent\nwith newline", RequestID: "req-1",
			Target:  audit.Target{Type: "app", ID: "web", Label: "=HYPERLINK(\"x\")"},
			Changes: []byte(`{"previous": {"name": "Web"}, "next": {"name": "-Web"}}`)}, ProjectRef: &auditlog.Project{Slug: "shop"}},
		{Entry: audit.Entry{ID: 1, Time: at, Kind: "member.added", Changes: []byte(`{"previous": null, "next": "admin"}`)}},
	}
	var buf bytes.Buffer
	x := auditlog.NewExport(len(entries), false, func(_ context.Context, fn func(auditlog.Entry) error) error {
		for _, e := range entries {
			if err := fn(e); err != nil {
				return err
			}
		}
		return nil
	})
	if err := writeAuditCSV(context.Background(), &buf, x); err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(&buf).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		auditCSVColumns,
		{"2026-11-13T10:00:00.123Z", "app.renamed", actor.String(), "Ada, \"the\" admin", "ada@example.com", "203.0.113.7", "agent\nwith newline", "req-1",
			"app", "web", "'=HYPERLINK(\"x\")", "shop", `{"name": "Web"}`, `{"name": "-Web"}`},
		{"2026-11-13T10:00:00.123Z", "member.added", "", "", "", "", "", "", "", "", "", "", "", `"admin"`},
	}
	if len(rows) != len(want) {
		t.Fatalf("rows = %q", rows)
	}
	for i := range want {
		if !slices.Equal(rows[i], want[i]) {
			t.Errorf("row %d = %q\nwant    %q", i, rows[i], want[i])
		}
	}
}

// countingWriter counts what is written and samples the heap every few
// writes, keeping the peak.
type countingWriter struct {
	n, writes int
	peak      uint64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	w.n += len(p)
	if w.writes++; w.writes%50 == 0 {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		w.peak = max(w.peak, m.HeapAlloc)
	}
	return len(p), nil
}

// TestWriteAuditCSVMemoryFlat streams a 100 000-row export and checks the
// heap never grows with it: rows are written and flushed as they come.
func TestWriteAuditCSVMemoryFlat(t *testing.T) {
	actor := uuid.New()
	changes := []byte(`{"previous": {"name": "old name of the app"}, "next": {"name": "new name of the app"}}`)
	x := auditlog.NewExport(audit.MaxExportRows, true, func(_ context.Context, fn func(auditlog.Entry) error) error {
		at := time.Now()
		for i := range audit.MaxExportRows {
			e := auditlog.Entry{Entry: audit.Entry{ID: int64(i), Time: at, Kind: "app.renamed", Actor: &actor, ActorLabel: "Ada Lovelace",
				ActorEmail: "ada@example.com", IP: "203.0.113.7", UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", RequestID: uuid.NewString(),
				Target: audit.Target{Type: "app", ID: strconv.Itoa(i), Label: "app-" + strconv.Itoa(i)}, Changes: changes}}
			if err := fn(e); err != nil {
				return err
			}
		}
		return nil
	})
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	w := &countingWriter{}
	if err := writeAuditCSV(context.Background(), w, x); err != nil {
		t.Fatal(err)
	}
	growth := int64(w.peak) - int64(before.HeapAlloc)
	t.Logf("wrote %d bytes (%.1f MiB) for %d rows; peak heap growth %.2f MiB", w.n, float64(w.n)/(1<<20), audit.MaxExportRows, float64(growth)/(1<<20))
	// The output is ~25 MiB; buffering it would grow the heap past that.
	// Streaming keeps the growth to garbage between collections.
	if limit := int64(w.n) / 3; growth > limit {
		t.Fatalf("peak heap grew %d bytes for %d bytes of output: the export is buffered", growth, w.n)
	}
}
