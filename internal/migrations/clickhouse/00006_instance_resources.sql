-- Runtime resources (M7, ADR 0010): one row per SDK process per heartbeat,
-- carrying the CPU, memory and runtime gauges the SDK aggregated over the
-- window (about a minute). Numeric values live in a Map keyed by dotted
-- metric names ("container.memory.working_set.max"): a missing key means the
-- SDK could not measure it, never zero, and new metrics need no migration.
-- Read a value with if(mapContains(metrics, k), metrics[k], NULL).
--
-- Every worker of a container reports the same container.* numbers; queries
-- keep one series per container_id and never sum workers. processes and
-- pools are the per-item lists as JSON, for the instance detail only.
--
-- The hourly rollup keeps sum, count, min and max per metric and instance,
-- so avg = sum / count. `apilens migrate` applies retention.resources and
-- retention.resources_1h on top (internal/migrations/retention.go).

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
CREATE TABLE IF NOT EXISTS app_instance_resources
(
    project_id          UUID,
    app_id              UUID,
    environment         LowCardinality(String),
    instance_id         String,
    ts                  DateTime64(3, 'UTC'),
    window_s            Float32,
    samples             UInt32,
    container_id        String,
    hostname            String,
    pod_name            String,
    namespace           LowCardinality(String),
    node_name           LowCardinality(String),
    platform            LowCardinality(String),
    limit_source        LowCardinality(String),
    sdk_name            LowCardinality(String),
    runtime             LowCardinality(String),
    release             LowCardinality(String),
    metrics             Map(LowCardinality(String), Float64),
    capabilities        Array(LowCardinality(String)),
    flags               Array(LowCardinality(String)),
    processes           String CODEC(ZSTD(3)),
    pools               String CODEC(ZSTD(3)),
    INDEX idx_container container_id TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (project_id, app_id, environment, instance_id, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS app_instance_resources_1h
(
    project_id      UUID,
    app_id          UUID,
    environment     LowCardinality(String),
    instance_id     String,
    container_id    String,
    bucket          DateTime('UTC'),
    heartbeats      SimpleAggregateFunction(sum, UInt64),
    metrics_sum     SimpleAggregateFunction(sumMap, Map(String, Float64)),
    metrics_count   SimpleAggregateFunction(sumMap, Map(String, UInt64)),
    metrics_min     SimpleAggregateFunction(minMap, Map(String, Float64)),
    metrics_max     SimpleAggregateFunction(maxMap, Map(String, Float64))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (project_id, app_id, environment, bucket, instance_id, container_id)
TTL bucket + INTERVAL 400 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS app_instance_resources_1h_mv TO app_instance_resources_1h AS
SELECT
    project_id,
    app_id,
    environment,
    instance_id,
    container_id,
    toStartOfHour(ts) AS bucket,
    count() AS heartbeats,
    sumMap(metrics) AS metrics_sum,
    sumMap(mapApply((k, v) -> (k, toUInt64(1)), metrics)) AS metrics_count,
    minMap(metrics) AS metrics_min,
    maxMap(metrics) AS metrics_max
FROM app_instance_resources
GROUP BY project_id, app_id, environment, instance_id, container_id, bucket;

-- +goose Down
DROP VIEW IF EXISTS app_instance_resources_1h_mv;
DROP TABLE IF EXISTS app_instance_resources_1h;
DROP TABLE IF EXISTS app_instance_resources;
