-- Remote control of runtime resources (M7, ADR 0010 D11), part of an app's
-- capture policy and returned on every heartbeat. Like the rest of the
-- policy it can only narrow what the SDK collects: turn resources off, ask
-- for a longer sampling interval, or switch single collectors off. It never
-- turns on what the SDK's local config turned off.

-- +goose Up
ALTER TABLE capture_policies
    ADD COLUMN IF NOT EXISTS resources_enabled        boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS resources_min_interval_s integer NOT NULL DEFAULT 15
        CHECK (resources_min_interval_s BETWEEN 15 AND 600),
    ADD COLUMN IF NOT EXISTS resources_disabled       text[]  NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE capture_policies
    DROP COLUMN IF EXISTS resources_disabled,
    DROP COLUMN IF EXISTS resources_min_interval_s,
    DROP COLUMN IF EXISTS resources_enabled;
