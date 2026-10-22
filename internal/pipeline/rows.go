// Package pipeline moves validated telemetry rows from the edge into
// ClickHouse. In direct mode (M1) rows are batched in-process; the Kafka
// sink (M3) uses the same row types and the protobuf contracts in
// proto/apilens/event/v1 on the wire.
package pipeline

import (
	"time"

	"github.com/google/uuid"
)

// RequestRow is one API request record (table api_requests).
type RequestRow struct {
	ProjectID       uuid.UUID
	AppID           uuid.UUID
	Environment     string
	Timestamp       time.Time
	Method          string
	Path            string
	RawPath         string
	StatusCode      uint16
	ResponseTimeMs  float64
	RequestSize     uint64
	ResponseSize    uint64
	IPAddress       string
	UserAgent       string
	ConsumerID      string
	ConsumerName    string
	ConsumerGroup   string
	RequestPayload  string
	ResponsePayload string
	RequestHeaders  string
	ResponseHeaders string
	BaseURL         string
	TraceID         string
	SpanID          string
	Release         string
	Commit          string
}

// LogRow is one log record (table api_logs).
type LogRow struct {
	ProjectID      uuid.UUID
	AppID          uuid.UUID
	Environment    string
	Timestamp      time.Time
	Level          string
	Message        string
	LoggerName     string
	EndpointMethod string
	EndpointPath   string
	StatusCode     uint16
	ConsumerID     string
	ConsumerName   string
	ConsumerGroup  string
	TraceID        string
	SpanID         string
	Payload        string
	Attributes     map[string]string
	Release        string
	Commit         string
}

// SpanRow is one span (table api_spans).
type SpanRow struct {
	ProjectID    uuid.UUID
	AppID        uuid.UUID
	Environment  string
	Timestamp    time.Time
	TraceID      string
	SpanID       string
	ParentSpanID string
	Name         string
	Kind         string
	ServiceName  string
	DurationMs   float64
	Status       string
	StatusCode   uint16
	Attributes   map[string]string
	Release      string
	Commit       string
}

// DeployRow is one deploy/release event (table api_deploys). AppID is the
// zero UUID for project-wide deploys.
type DeployRow struct {
	ProjectID   uuid.UUID
	AppID       uuid.UUID
	Environment string
	Release     string
	Commit      string
	URL         string
	DeployedAt  time.Time
}
