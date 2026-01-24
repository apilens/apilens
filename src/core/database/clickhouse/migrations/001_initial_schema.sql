-- ItsFriday Initial ClickHouse Schema
-- Migration: 001_initial_schema

-- =============================================================================
-- Metrics Table
-- =============================================================================
-- Stores time-series metrics data with tenant isolation
CREATE TABLE IF NOT EXISTS metrics (
    timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    tenant_id String CODEC(ZSTD(1)),
    metric_name LowCardinality(String) CODEC(ZSTD(1)),
    value Float64 CODEC(Gorilla, ZSTD(1)),
    tags Map(String, String) CODEC(ZSTD(1))
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, metric_name, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Bloom filter indexes for efficient filtering
ALTER TABLE metrics ADD INDEX idx_tenant_id tenant_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE metrics ADD INDEX idx_metric_name metric_name TYPE bloom_filter(0.01) GRANULARITY 1;

-- =============================================================================
-- Logs Table
-- =============================================================================
-- Stores structured log data with tenant isolation
CREATE TABLE IF NOT EXISTS logs (
    timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    tenant_id String CODEC(ZSTD(1)),
    level LowCardinality(String) CODEC(ZSTD(1)),
    message String CODEC(ZSTD(1)),
    attributes Map(String, String) CODEC(ZSTD(1)),
    trace_id String CODEC(ZSTD(1)),
    span_id String CODEC(ZSTD(1))
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Bloom filter indexes
ALTER TABLE logs ADD INDEX idx_logs_tenant_id tenant_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE logs ADD INDEX idx_logs_level level TYPE set(10) GRANULARITY 1;
ALTER TABLE logs ADD INDEX idx_logs_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1;

-- =============================================================================
-- Traces Table
-- =============================================================================
-- Stores distributed trace spans
CREATE TABLE IF NOT EXISTS traces (
    timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    tenant_id String CODEC(ZSTD(1)),
    trace_id String CODEC(ZSTD(1)),
    span_id String CODEC(ZSTD(1)),
    parent_span_id String CODEC(ZSTD(1)),
    operation_name LowCardinality(String) CODEC(ZSTD(1)),
    service_name LowCardinality(String) CODEC(ZSTD(1)),
    duration_ms Float64 CODEC(Gorilla, ZSTD(1)),
    status_code LowCardinality(String) CODEC(ZSTD(1)),
    attributes Map(String, String) CODEC(ZSTD(1))
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, trace_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- Indexes
ALTER TABLE traces ADD INDEX idx_traces_tenant_id tenant_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE traces ADD INDEX idx_traces_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE traces ADD INDEX idx_traces_service_name service_name TYPE bloom_filter(0.01) GRANULARITY 1;

-- =============================================================================
-- Events Table
-- =============================================================================
-- Stores application events and custom telemetry
CREATE TABLE IF NOT EXISTS events (
    timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    tenant_id String CODEC(ZSTD(1)),
    event_type LowCardinality(String) CODEC(ZSTD(1)),
    event_name String CODEC(ZSTD(1)),
    payload String CODEC(ZSTD(1)),
    attributes Map(String, String) CODEC(ZSTD(1))
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, event_type, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Indexes
ALTER TABLE events ADD INDEX idx_events_tenant_id tenant_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE events ADD INDEX idx_events_event_type event_type TYPE bloom_filter(0.01) GRANULARITY 1;
