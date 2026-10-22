package pipeline

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// ClickHouseInserters returns native-protocol, column-oriented batch
// inserters for every telemetry table.
func ClickHouseInserters(conn driver.Conn) Inserters {
	return Inserters{
		Requests: func(ctx context.Context, rows []RequestRow) error {
			return insertBatch(ctx, conn, insertRequests, rows, func(b driver.Batch, r RequestRow) error {
				return b.Append(r.ProjectID, r.AppID, r.Environment, r.Timestamp, r.Method, r.Path, r.RawPath,
					r.StatusCode, r.ResponseTimeMs, r.RequestSize, r.ResponseSize, r.IPAddress, r.UserAgent,
					r.ConsumerID, r.ConsumerName, r.ConsumerGroup, r.RequestPayload, r.ResponsePayload,
					r.RequestHeaders, r.ResponseHeaders, r.BaseURL, r.TraceID, r.SpanID, r.Release, r.Commit)
			})
		},
		Logs: func(ctx context.Context, rows []LogRow) error {
			return insertBatch(ctx, conn, insertLogs, rows, func(b driver.Batch, r LogRow) error {
				return b.Append(r.ProjectID, r.AppID, r.Environment, r.Timestamp, r.Level, r.Message, r.LoggerName,
					r.EndpointMethod, r.EndpointPath, r.StatusCode, r.ConsumerID, r.ConsumerName, r.ConsumerGroup,
					r.TraceID, r.SpanID, r.Payload, nonNilMap(r.Attributes), r.Release, r.Commit)
			})
		},
		Spans: func(ctx context.Context, rows []SpanRow) error {
			return insertBatch(ctx, conn, insertSpans, rows, func(b driver.Batch, r SpanRow) error {
				return b.Append(r.ProjectID, r.AppID, r.Environment, r.Timestamp, r.TraceID, r.SpanID, r.ParentSpanID,
					r.Name, r.Kind, r.ServiceName, r.DurationMs, r.Status, r.StatusCode, nonNilMap(r.Attributes),
					r.Release, r.Commit)
			})
		},
		Deploys: func(ctx context.Context, rows []DeployRow) error {
			return insertBatch(ctx, conn, insertDeploys, rows, func(b driver.Batch, r DeployRow) error {
				return b.Append(r.ProjectID, r.AppID, r.Environment, r.Release, r.Commit, r.URL, r.DeployedAt)
			})
		},
	}
}

const (
	insertRequests = `INSERT INTO api_requests (project_id, app_id, environment, timestamp, method, path, raw_path,
		status_code, response_time_ms, request_size, response_size, ip_address, user_agent, consumer_id,
		consumer_name, consumer_group, request_payload, response_payload, request_headers, response_headers,
		base_url, trace_id, span_id, release, commit)`
	insertLogs = `INSERT INTO api_logs (project_id, app_id, environment, timestamp, level, message, logger_name,
		endpoint_method, endpoint_path, status_code, consumer_id, consumer_name, consumer_group, trace_id, span_id,
		payload, attributes, release, commit)`
	insertSpans = `INSERT INTO api_spans (project_id, app_id, environment, timestamp, trace_id, span_id,
		parent_span_id, name, kind, service_name, duration_ms, status, status_code, attributes, release, commit)`
	insertDeploys = `INSERT INTO api_deploys (project_id, app_id, environment, release, commit, url, deployed_at)`
)

func insertBatch[T any](ctx context.Context, conn driver.Conn, query string, rows []T, appendRow func(driver.Batch, T) error) error {
	batch, err := conn.PrepareBatch(ctx, query)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	for i := range rows {
		if err := appendRow(batch, rows[i]); err != nil {
			_ = batch.Abort()
			return fmt.Errorf("append row %d: %w", i, err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	return nil
}

func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
