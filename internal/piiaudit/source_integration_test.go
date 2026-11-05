//go:build integration

package piiaudit

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/testutil"
)

func TestScanClickHouse(t *testing.T) {
	ctx := context.Background()
	cfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, cfg, testutil.Logger(t)); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	project, other := uuid.New(), uuid.New()
	now := time.Now().UTC()
	batch, err := conn.PrepareBatch(ctx, `INSERT INTO api_requests
		(project_id, app_id, timestamp, method, path, raw_path, request_headers, response_headers, request_payload, response_payload)`)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []struct {
		project uuid.UUID
		at      time.Time
		path    string
		rawPath string
		reqBody string
	}{
		{project, now.Add(-time.Minute), "/users", "/users?email=jane%40example.com", `{"card":"4111111111111111"}`},
		{project, now.Add(-2 * time.Minute), "/users", "/users", `{"card":"[redacted]"}`},
		{project, now.Add(-3 * time.Hour), "/old", "/old", `{"email":"old@example.com"}`},   // outside -since
		{other, now.Add(-time.Minute), "/other", "/other", `{"email":"other@example.com"}`}, // other project
	} {
		if err := batch.Append(r.project, uuid.Nil, r.at, "POST", r.path, r.rawPath, "{}", "{}", r.reqBody, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := batch.Send(); err != nil {
		t.Fatal(err)
	}

	s := NewScanner(DefaultDetectors())
	if err := ScanClickHouse(ctx, conn, Sample{ProjectID: project, Since: time.Hour, Limit: 100}, s); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range s.Findings() {
		got = append(got, f.Endpoint+"|"+f.Field+"|"+f.Pattern)
	}
	slices.Sort(got)
	if want := []string{"POST /users|raw_path|email", "POST /users|request_payload|card"}; !slices.Equal(got, want) {
		t.Fatalf("findings = %q, want %q", got, want)
	}
	if s.Records() != 2 {
		t.Fatalf("records = %d, want 2", s.Records())
	}

	s = NewScanner(DefaultDetectors())
	if err := ScanClickHouse(ctx, conn, Sample{ProjectID: project, Since: time.Hour, Limit: 1}, s); err != nil {
		t.Fatal(err)
	}
	if s.Records() != 1 {
		t.Fatalf("limited records = %d, want 1", s.Records())
	}
}
