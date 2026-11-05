-- First and last sighting of every API consumer of a project, kept by a
-- materialized view over api_requests so "new vs returning" does not scan
-- raw rows back to the beginning of time. A consumer is new in a window
-- when its first_seen falls inside it. Rows are merged per
-- (project_id, consumer_id); read them with min(first_seen),
-- max(last_seen) and argMaxMerge(consumer_name). No TTL: the table outlives
-- raw request retention on purpose (one small row per consumer).

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
CREATE TABLE IF NOT EXISTS api_consumers
(
    project_id     UUID,
    consumer_id    String,
    first_seen     SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    last_seen      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
    consumer_name  AggregateFunction(argMax, String, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY (project_id, consumer_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS api_consumers_mv TO api_consumers AS
SELECT
    project_id,
    consumer_id,
    min(timestamp) AS first_seen,
    max(timestamp) AS last_seen,
    argMaxState(consumer_name, timestamp) AS consumer_name
FROM api_requests
WHERE consumer_id != ''
GROUP BY project_id, consumer_id;

-- Backfill from the raw rows already stored. min, max and argMax are
-- idempotent, so rows the view also saw while this ran are harmless.
INSERT INTO api_consumers
SELECT
    project_id,
    consumer_id,
    min(timestamp),
    max(timestamp),
    argMaxState(consumer_name, timestamp)
FROM api_requests
WHERE consumer_id != ''
GROUP BY project_id, consumer_id;

-- +goose Down
DROP VIEW IF EXISTS api_consumers_mv;
DROP TABLE IF EXISTS api_consumers;
