-- api_requests table for endpoint monitoring
-- Migration: 002_api_requests

CREATE TABLE IF NOT EXISTS api_requests (
    timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
    app_id String CODEC(ZSTD(1)),
    endpoint_id String CODEC(ZSTD(1)),
    environment LowCardinality(String) CODEC(ZSTD(1)),
    method LowCardinality(String) CODEC(ZSTD(1)),
    path String CODEC(ZSTD(1)),
    status_code UInt16 CODEC(ZSTD(1)),
    response_time_ms Float64 CODEC(Gorilla, ZSTD(1)),
    request_size UInt64 CODEC(ZSTD(1)),
    response_size UInt64 CODEC(ZSTD(1)),
    ip_address String CODEC(ZSTD(1)),
    user_agent String CODEC(ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (app_id, environment, method, path, timestamp)
TTL toDateTime(timestamp) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE api_requests ADD INDEX idx_api_requests_app_id app_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE api_requests ADD INDEX idx_api_requests_environment environment TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE api_requests ADD INDEX idx_api_requests_endpoint_id endpoint_id TYPE bloom_filter(0.01) GRANULARITY 1;
