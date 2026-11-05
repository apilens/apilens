-- New api_requests fields emitted by the M3 SDKs:
--   sampled            0 when the SDK sampled the request out (base record
--                      only; still counted by the rollups);
--   attributes         custom request attributes (at most 32);
--   validation_errors  JSON array of {loc, msg, type} from a 422 ('' if none).
-- Defaults keep existing rows and rows from older SDKs meaning "sampled, no
-- attributes, no validation errors".

-- ClickHouse DDL is not transactional; every statement is idempotent instead.
-- +goose NO TRANSACTION

-- +goose Up
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS sampled UInt8 DEFAULT 1;
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS attributes Map(String, String) CODEC(ZSTD(3));
ALTER TABLE api_requests ADD COLUMN IF NOT EXISTS validation_errors String CODEC(ZSTD(3));

-- +goose Down
ALTER TABLE api_requests DROP COLUMN IF EXISTS validation_errors;
ALTER TABLE api_requests DROP COLUMN IF EXISTS attributes;
ALTER TABLE api_requests DROP COLUMN IF EXISTS sampled;
