-- Request log exports: a CSV (gzip) of the filtered request log, written by
-- a River job (query.export) and downloaded through a signed URL.
--
--   projects 1 ── * request_exports.project_id
--   users    1 ── * request_exports.created_by
--
-- filter is the request log filter the export was asked with; range_from and
-- range_to pin its time range when it was asked, so a retried job writes the
-- same rows. status moves
--
--   queued ──> running ──> completed ──(expires_at)──> expired
--                     └──> failed
--   queued | running ──> cancelled
--
-- total_rows is the number of rows the job will write (capped at
-- row_limit), set once it starts; rows_written is its progress. file_key
-- names the file in the export store while completed. signing_key is a
-- random per-export HMAC key for its download URLs. created_by is NULL once
-- the creator's user is gone; the cleanup job still removes the file.

-- +goose Up
CREATE TABLE IF NOT EXISTS request_exports (
    id           uuid PRIMARY KEY,
    project_id   uuid        NOT NULL REFERENCES projects (id),
    created_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    filter       jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filter) = 'object'),
    range_from   timestamptz NOT NULL,
    range_to     timestamptz NOT NULL,
    status       text        NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'running', 'completed', 'failed', 'cancelled', 'expired')),
    row_limit    bigint      NOT NULL CHECK (row_limit > 0),
    total_rows   bigint,
    rows_written bigint      NOT NULL DEFAULT 0,
    size_bytes   bigint      NOT NULL DEFAULT 0,
    file_key     text,
    error        text,
    signing_key  bytea       NOT NULL CHECK (length(signing_key) = 32),
    created_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    finished_at  timestamptz,
    expires_at   timestamptz
);
CREATE INDEX IF NOT EXISTS request_exports_expiring
    ON request_exports (expires_at) WHERE status = 'completed';

-- +goose Down
DROP TABLE IF EXISTS request_exports;
