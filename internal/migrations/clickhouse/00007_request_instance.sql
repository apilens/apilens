-- Per-instance request metrics (M7, ADR 0010): every request record names
-- the SDK process that served it (instance_id, the heartbeat's), so latency,
-- throughput and errors can sit next to that process's CPU and memory.
-- Older SDKs send none: their rows keep '' and stay out of the rollup.
--
-- api_requests_instance_1m is the per-minute rollup per instance behind the
-- instances table and its sparklines. Like api_requests_1m it keeps 30 days.

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS instance_id LowCardinality(String) DEFAULT '';

CREATE TABLE IF NOT EXISTS api_requests_instance_1m
(
    project_id      UUID,
    app_id          UUID,
    environment     LowCardinality(String),
    instance_id     LowCardinality(String),
    bucket          DateTime('UTC'),
    requests        SimpleAggregateFunction(sum, UInt64),
    client_errors   SimpleAggregateFunction(sum, UInt64),
    server_errors   SimpleAggregateFunction(sum, UInt64),
    latency_sum_ms  SimpleAggregateFunction(sum, Float64),
    latency_max_ms  SimpleAggregateFunction(max, Float64),
    latency         AggregateFunction(quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99), Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(bucket)
ORDER BY (project_id, app_id, environment, instance_id, bucket)
TTL bucket + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS api_requests_instance_1m_mv TO api_requests_instance_1m AS
SELECT
    project_id,
    app_id,
    environment,
    instance_id,
    toStartOfMinute(timestamp) AS bucket,
    count() AS requests,
    countIf(status_code >= 400 AND status_code < 500) AS client_errors,
    countIf(status_code >= 500) AS server_errors,
    sum(response_time_ms) AS latency_sum_ms,
    max(response_time_ms) AS latency_max_ms,
    quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(response_time_ms) AS latency
FROM api_requests
WHERE instance_id != ''
GROUP BY project_id, app_id, environment, instance_id, bucket;

-- +goose Down
DROP VIEW IF EXISTS api_requests_instance_1m_mv;
DROP TABLE IF EXISTS api_requests_instance_1m;
ALTER TABLE api_requests DROP COLUMN IF EXISTS instance_id;
