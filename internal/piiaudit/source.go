package piiaudit

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"
)

// ScanFields are the api_requests columns that carry captured values.
var ScanFields = []string{"raw_path", "request_headers", "response_headers", "request_payload", "response_payload"}

// csvSkip are export columns that never hold captured values: identifiers,
// timings and sizes. Every other column is scanned.
var csvSkip = []string{
	"method", "path", "timestamp", "status_code", "response_time_ms", "request_size", "response_size",
	"project_id", "app_id", "environment", "trace_id", "span_id", "release", "commit", "base_url",
}

// ScanCSV scans an export with a header row. The endpoint is built from the
// method and path columns (raw_path when there is no path); every other
// column except identifiers, timings and sizes is scanned.
func ScanCSV(r io.Reader, s *Scanner) error {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	header, err := cr.Read()
	if errors.Is(err, io.EOF) {
		return errors.New("csv: empty file")
	}
	if err != nil {
		return fmt.Errorf("csv: %w", err)
	}
	names := make([]string, len(header))
	col := map[string]int{}
	for i, h := range header {
		names[i] = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(h, "\ufeff")))
		col[names[i]] = i
	}
	pathCol, ok := col["path"]
	if !ok {
		pathCol, ok = col["raw_path"]
	}
	if !ok {
		return errors.New("csv: need a path or raw_path column")
	}
	methodCol, hasMethod := col["method"]
	var scan []int
	for i, name := range names {
		if !slices.Contains(csvSkip, name) {
			scan = append(scan, i)
		}
	}
	for {
		row, err := cr.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("csv: %w", err)
		}
		get := func(i int) string {
			if i < len(row) {
				return row[i]
			}
			return ""
		}
		endpoint := get(pathCol)
		if hasMethod {
			endpoint = get(methodCol) + " " + endpoint
		}
		rec := Record{Endpoint: endpoint}
		for _, i := range scan {
			if v := get(i); v != "" {
				rec.Fields = append(rec.Fields, Field{Name: names[i], Value: v})
			}
		}
		s.Scan(rec)
	}
}

// Sample selects the ClickHouse rows to scan.
type Sample struct {
	ProjectID uuid.UUID
	Since     time.Duration
	Limit     int
}

// ScanClickHouse scans the newest captured requests of one project.
func ScanClickHouse(ctx context.Context, conn driver.Conn, q Sample, s *Scanner) error {
	if q.Since <= 0 {
		return errors.New("since must be positive")
	}
	if q.Limit <= 0 {
		return errors.New("limit must be positive")
	}
	rows, err := conn.Query(ctx, `
		SELECT method, path, `+strings.Join(ScanFields, ", ")+`
		FROM api_requests
		WHERE project_id = ? AND timestamp >= now64(3) - toIntervalMillisecond(?)
		ORDER BY timestamp DESC
		LIMIT ?`, q.ProjectID, q.Since.Milliseconds(), q.Limit)
	if err != nil {
		return fmt.Errorf("clickhouse: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var method, path string
		values := make([]string, len(ScanFields))
		dest := []any{&method, &path}
		for i := range values {
			dest = append(dest, &values[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return fmt.Errorf("clickhouse: %w", err)
		}
		rec := Record{Endpoint: method + " " + path}
		for i, v := range values {
			if v != "" {
				rec.Fields = append(rec.Fields, Field{Name: ScanFields[i], Value: v})
			}
		}
		s.Scan(rec)
	}
	return rows.Err()
}
