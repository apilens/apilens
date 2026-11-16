-- Logs and spans keep 90 days, the same as api_requests (M5 decision D6), so
-- a request's exception and trace outlive it no sooner than the request does.
-- `apilens migrate` then applies retention.logs / retention.spans on top
-- (internal/migrations/retention.go); their defaults are 90 days too.

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
ALTER TABLE api_logs MODIFY TTL toDateTime(timestamp) + INTERVAL 90 DAY;
ALTER TABLE api_spans MODIFY TTL toDateTime(timestamp) + INTERVAL 90 DAY;

-- +goose Down
ALTER TABLE api_spans MODIFY TTL toDateTime(timestamp) + INTERVAL 30 DAY;
ALTER TABLE api_logs MODIFY TTL toDateTime(timestamp) + INTERVAL 30 DAY;
