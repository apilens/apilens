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
	// InstanceID is the SDK process (heartbeat instance_id); "" from
	// older SDKs.
	InstanceID string
	// Sampled is false when the SDK sampled the request out: the base
	// record still counts in metrics but carries no headers or bodies.
	// Producers must set it; the zero value means "sampled out".
	Sampled          bool
	Attributes       map[string]string
	ValidationErrors []ValidationError
}

// ValidationError is one structured field error of a rejected (422)
// request. Stored as a JSON array in api_requests.validation_errors.
type ValidationError struct {
	Loc  string `json:"loc"`
	Msg  string `json:"msg"`
	Type string `json:"type"`
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
	// StatusMessage is the status description, e.g. why the span failed.
	StatusMessage string
	Events        []SpanEventRow
	Links         []SpanLink
}

// SpanEventRow is one timestamped event inside a span (the Nested column
// api_spans.events), e.g. an `exception` event.
type SpanEventRow struct {
	Time       time.Time
	Name       string
	Attributes map[string]string
}

// SpanLink points at another span (an element of api_spans.links). The ch
// tags name the tuple elements.
type SpanLink struct {
	TraceID string `ch:"trace_id"`
	SpanID  string `ch:"span_id"`
}

// ResourceRow is one SDK heartbeat's runtime resources (table
// app_instance_resources, M7). Metrics holds the measured values by dotted
// name; a metric that was not measured is absent, never zero.
type ResourceRow struct {
	ProjectID    uuid.UUID
	AppID        uuid.UUID
	Environment  string
	InstanceID   string
	Timestamp    time.Time
	WindowS      float32
	Samples      uint32
	ContainerID  string
	Hostname     string
	PodName      string
	Namespace    string
	NodeName     string
	Platform     string
	LimitSource  string
	SDKName      string
	Runtime      string
	Release      string
	Metrics      map[string]float64
	Capabilities []string
	Flags        []string
	Processes    string // JSON array, "" when not sent
	Pools        string // JSON array, "" when not sent
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
