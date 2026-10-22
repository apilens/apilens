-- Telemetry schema, v2 baseline (single node; ON CLUSTER arrives with the
-- replicated topology in M3).
--
-- Design rules:
--   * tenant first in ORDER BY (every query is project-scoped);
--   * daily partitions + ttl_only_drop_parts so retention drops whole parts;
--   * heavy text columns compressed with ZSTD;
--   * dashboards read the *_1m / *_1h rollups, not raw rows.

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
CREATE TABLE IF NOT EXISTS api_requests
(
    project_id        UUID,
    app_id            UUID,
    environment       LowCardinality(String),
    timestamp         DateTime64(3, 'UTC'),
    method            LowCardinality(String),
    path              String,
    raw_path          String CODEC(ZSTD(1)),
    status_code       UInt16,
    response_time_ms  Float64,
    request_size      UInt64,
    response_size     UInt64,
    ip_address        String,
    user_agent        String CODEC(ZSTD(1)),
    consumer_id       String,
    consumer_name     String,
    consumer_group    LowCardinality(String),
    request_payload   String CODEC(ZSTD(3)),
    response_payload  String CODEC(ZSTD(3)),
    request_headers   String CODEC(ZSTD(3)),
    response_headers  String CODEC(ZSTD(3)),
    base_url          LowCardinality(String),
    trace_id          String,
    span_id           String,
    release           LowCardinality(String),
    commit            LowCardinality(String),
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_consumer_id consumer_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_status status_code TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (project_id, app_id, toStartOfHour(timestamp), environment, path, method, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS api_logs
(
    project_id       UUID,
    app_id           UUID,
    environment      LowCardinality(String),
    timestamp        DateTime64(3, 'UTC'),
    level            LowCardinality(String),
    message          String CODEC(ZSTD(3)),
    logger_name      LowCardinality(String),
    endpoint_method  LowCardinality(String),
    endpoint_path    String,
    status_code      UInt16,
    consumer_id      String,
    consumer_name    String,
    consumer_group   LowCardinality(String),
    trace_id         String,
    span_id          String,
    payload          String CODEC(ZSTD(3)),
    attributes       Map(LowCardinality(String), String) CODEC(ZSTD(3)),
    release          LowCardinality(String),
    commit           LowCardinality(String),
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_message message TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (project_id, app_id, toStartOfHour(timestamp), level, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Spans are keyed by trace so the waterfall view reads one contiguous range.
CREATE TABLE IF NOT EXISTS api_spans
(
    project_id      UUID,
    app_id          UUID,
    environment     LowCardinality(String),
    timestamp       DateTime64(6, 'UTC'),
    trace_id        String,
    span_id         String,
    parent_span_id  String,
    name            String,
    kind            LowCardinality(String),
    service_name    LowCardinality(String),
    duration_ms     Float64,
    status          LowCardinality(String),
    status_code     UInt16,
    attributes      Map(LowCardinality(String), String) CODEC(ZSTD(3)),
    release         LowCardinality(String),
    commit          LowCardinality(String),
    INDEX idx_app app_id TYPE set(0) GRANULARITY 4,
    INDEX idx_ts timestamp TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(timestamp)
ORDER BY (project_id, trace_id, timestamp, span_id)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- app_id is the zero UUID for project-wide deploys.
CREATE TABLE IF NOT EXISTS api_deploys
(
    project_id   UUID,
    app_id       UUID,
    environment  LowCardinality(String),
    release      String,
    commit       String,
    url          String,
    deployed_at  DateTime64(3, 'UTC'),
    received_at  DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(deployed_at)
ORDER BY (project_id, environment, deployed_at, release)
TTL toDateTime(deployed_at) + INTERVAL 400 DAY;

-- Per-minute request rollup (traffic, client 4xx vs server 5xx, latency).
CREATE TABLE IF NOT EXISTS api_requests_1m
(
    project_id      UUID,
    app_id          UUID,
    environment     LowCardinality(String),
    path            String,
    method          LowCardinality(String),
    bucket          DateTime('UTC'),
    requests        SimpleAggregateFunction(sum, UInt64),
    client_errors   SimpleAggregateFunction(sum, UInt64),
    server_errors   SimpleAggregateFunction(sum, UInt64),
    latency_sum_ms  SimpleAggregateFunction(sum, Float64),
    latency_max_ms  SimpleAggregateFunction(max, Float64),
    latency         AggregateFunction(quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99), Float64),
    request_bytes   SimpleAggregateFunction(sum, UInt64),
    response_bytes  SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(bucket)
ORDER BY (project_id, app_id, environment, bucket, path, method)
TTL bucket + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS api_requests_1m_mv TO api_requests_1m AS
SELECT
    project_id,
    app_id,
    environment,
    path,
    method,
    toStartOfMinute(timestamp) AS bucket,
    count() AS requests,
    countIf(status_code >= 400 AND status_code < 500) AS client_errors,
    countIf(status_code >= 500) AS server_errors,
    sum(response_time_ms) AS latency_sum_ms,
    max(response_time_ms) AS latency_max_ms,
    quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(response_time_ms) AS latency,
    sum(request_size) AS request_bytes,
    sum(response_size) AS response_bytes
FROM api_requests
GROUP BY project_id, app_id, environment, path, method, bucket;

-- Per-hour rollup for long ranges (fed from raw rows, so it does not depend
-- on the 1m table's retention).
CREATE TABLE IF NOT EXISTS api_requests_1h
(
    project_id      UUID,
    app_id          UUID,
    environment     LowCardinality(String),
    path            String,
    method          LowCardinality(String),
    bucket          DateTime('UTC'),
    requests        SimpleAggregateFunction(sum, UInt64),
    client_errors   SimpleAggregateFunction(sum, UInt64),
    server_errors   SimpleAggregateFunction(sum, UInt64),
    latency_sum_ms  SimpleAggregateFunction(sum, Float64),
    latency_max_ms  SimpleAggregateFunction(max, Float64),
    latency         AggregateFunction(quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99), Float64),
    request_bytes   SimpleAggregateFunction(sum, UInt64),
    response_bytes  SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (project_id, app_id, environment, bucket, path, method)
TTL bucket + INTERVAL 400 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS api_requests_1h_mv TO api_requests_1h AS
SELECT
    project_id,
    app_id,
    environment,
    path,
    method,
    toStartOfHour(timestamp) AS bucket,
    count() AS requests,
    countIf(status_code >= 400 AND status_code < 500) AS client_errors,
    countIf(status_code >= 500) AS server_errors,
    sum(response_time_ms) AS latency_sum_ms,
    max(response_time_ms) AS latency_max_ms,
    quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(response_time_ms) AS latency,
    sum(request_size) AS request_bytes,
    sum(response_size) AS response_bytes
FROM api_requests
GROUP BY project_id, app_id, environment, path, method, bucket;

-- +goose Down
DROP VIEW IF EXISTS api_requests_1h_mv;
DROP TABLE IF EXISTS api_requests_1h;
DROP VIEW IF EXISTS api_requests_1m_mv;
DROP TABLE IF EXISTS api_requests_1m;
DROP TABLE IF EXISTS api_deploys;
DROP TABLE IF EXISTS api_spans;
DROP TABLE IF EXISTS api_logs;
DROP TABLE IF EXISTS api_requests;
