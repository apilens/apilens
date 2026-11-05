-- Remote capture policy: what the SDKs of one app capture, returned to them
-- on heartbeat so it can change without a redeploy. One row per app; an app
-- without a row captures everything (enabled, sample_rate 1, headers and
-- bodies on, no payload cap beyond the SDK's own). max_payload_bytes NULL
-- means no extra cap. updated_by is the user who last saved the row.

-- +goose Up
CREATE TABLE IF NOT EXISTS capture_policies (
    app_id                uuid PRIMARY KEY REFERENCES apps (id),
    enabled               boolean      NOT NULL DEFAULT true,
    sample_rate           numeric(5,4) NOT NULL DEFAULT 1 CHECK (sample_rate >= 0 AND sample_rate <= 1),
    capture_headers       boolean      NOT NULL DEFAULT true,
    capture_request_body  boolean      NOT NULL DEFAULT true,
    capture_response_body boolean      NOT NULL DEFAULT true,
    max_payload_bytes     integer      CHECK (max_payload_bytes BETWEEN 1 AND 1048576),
    updated_at            timestamptz  NOT NULL DEFAULT now(),
    updated_by            uuid         REFERENCES users (id) ON DELETE SET NULL
);

-- +goose Down
DROP TABLE IF EXISTS capture_policies;
