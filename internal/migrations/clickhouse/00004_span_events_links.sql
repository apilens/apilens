-- Span status message, events and links, so a span keeps what OTel gives it:
--   status_message  the status description (why the span failed);
--   events          timestamped span events, e.g. the `exception` event
--                   with exception.type/message/stacktrace attributes. A
--                   Nested column, stored as the parallel arrays
--                   events.time / events.name / events.attributes;
--   links           (trace_id, span_id) of the spans this span links to.
-- Defaults keep existing rows and rows from older SDKs meaning "no message,
-- no events, no links".

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
ALTER TABLE api_spans ADD COLUMN IF NOT EXISTS status_message String CODEC(ZSTD(3));
ALTER TABLE api_spans ADD COLUMN IF NOT EXISTS events Nested(time DateTime64(9, 'UTC'), name LowCardinality(String), attributes Map(LowCardinality(String), String)) CODEC(ZSTD(3));
ALTER TABLE api_spans ADD COLUMN IF NOT EXISTS links Array(Tuple(trace_id String, span_id String)) CODEC(ZSTD(3));

-- +goose Down
ALTER TABLE api_spans DROP COLUMN IF EXISTS links;
ALTER TABLE api_spans DROP COLUMN IF EXISTS `events.attributes`;
ALTER TABLE api_spans DROP COLUMN IF EXISTS `events.name`;
ALTER TABLE api_spans DROP COLUMN IF EXISTS `events.time`;
ALTER TABLE api_spans DROP COLUMN IF EXISTS status_message;
