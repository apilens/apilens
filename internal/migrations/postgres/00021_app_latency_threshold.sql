-- App-wide Apdex threshold: the response time T in milliseconds at or below
-- which a request of the app is satisfied (tolerating up to 4T). NULL means
-- the built-in default of 500 ms. An endpoint's own
-- endpoint_settings.latency_threshold_ms takes precedence over it.

-- +goose Up
ALTER TABLE apps
    ADD COLUMN IF NOT EXISTS latency_threshold_ms integer
        CHECK (latency_threshold_ms BETWEEN 1 AND 600000);

-- +goose Down
ALTER TABLE apps DROP COLUMN IF EXISTS latency_threshold_ms;
