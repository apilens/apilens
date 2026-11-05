-- Per-endpoint settings of an app, keyed by method and route template:
--   expected_status_codes  responses that are not failures for this endpoint
--                          (e.g. 404 on a lookup); the dashboard error rates
--                          leave them out;
--   latency_threshold_ms   response time above which a request counts as
--                          slow (NULL: the project default);
--   excluded               hides the endpoint from the dashboard lists and
--                          summaries; its requests stay in Explore.
-- An endpoint without a row has the defaults (no expected codes, no
-- threshold, not excluded). updated_by is the user who last saved the row.

-- +goose Up
CREATE TABLE IF NOT EXISTS endpoint_settings (
    app_id                uuid        NOT NULL REFERENCES apps (id),
    method                text        NOT NULL CHECK (method ~ '^[A-Z]{1,16}$'),
    path                  text        NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
    expected_status_codes integer[]   NOT NULL DEFAULT '{}'
        CHECK (cardinality(expected_status_codes) <= 32
               AND 100 <= ALL (expected_status_codes) AND 599 >= ALL (expected_status_codes)),
    latency_threshold_ms  integer     CHECK (latency_threshold_ms BETWEEN 1 AND 600000),
    excluded              boolean     NOT NULL DEFAULT false,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    updated_by            uuid        REFERENCES users (id) ON DELETE SET NULL,
    PRIMARY KEY (app_id, method, path)
);

-- +goose Down
DROP TABLE IF EXISTS endpoint_settings;
