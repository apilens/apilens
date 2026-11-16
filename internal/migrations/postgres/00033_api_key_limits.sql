-- Per-key ingest rate limit (#775).
--
--   rate_limit_per_minute  the most records (requests, logs, spans, deploys)
--                          the ingest edge accepts with this key per minute,
--                          on top of the project quota. NULL: no per-key
--                          limit. Enforced with the same Valkey token bucket
--                          as ingest.quota, answering 429 with Retry-After.
--
-- The cap on keys per project (ingest.max_keys_per_project) is config, not
-- schema: it counts the project's active keys under the project row lock.

-- +goose Up
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS rate_limit_per_minute integer CHECK (rate_limit_per_minute > 0);

-- +goose Down
ALTER TABLE api_keys
    DROP COLUMN IF EXISTS rate_limit_per_minute;
