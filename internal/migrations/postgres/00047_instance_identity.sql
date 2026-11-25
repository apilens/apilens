-- Runtime resources (M7, ADR 0010): where each SDK process runs, its latest
-- resources snapshot and how it ended. The heartbeat writes identity and the
-- snapshot on every beat; the full history is ClickHouse
-- app_instance_resources. ended_at/ended_reason are set by the final
-- heartbeat of a clean shutdown (graceful) or inferred when a new process
-- appears in the same container (restart, oom, suspected_oom); a later
-- heartbeat of the same instance clears them again.

-- +goose Up
ALTER TABLE app_instances
    ADD COLUMN IF NOT EXISTS hostname           text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS hostname_guess     boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS container_id       text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS pod_name           text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS pod_uid            text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS namespace          text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS node_name          text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS platform           text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS region             text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS process_start_time timestamptz,
    ADD COLUMN IF NOT EXISTS uptime_s           double precision,
    ADD COLUMN IF NOT EXISTS resources          jsonb,
    ADD COLUMN IF NOT EXISTS ended_at           timestamptz,
    ADD COLUMN IF NOT EXISTS ended_reason       text NOT NULL DEFAULT ''
        CHECK (ended_reason IN ('', 'graceful', 'restart', 'oom', 'suspected_oom'));
-- The open instances of a container, for restart/OOM inference.
CREATE INDEX IF NOT EXISTS app_instances_container ON app_instances (app_id, environment, container_id)
    WHERE container_id <> '' AND ended_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS app_instances_container;
ALTER TABLE app_instances
    DROP COLUMN IF EXISTS ended_reason,
    DROP COLUMN IF EXISTS ended_at,
    DROP COLUMN IF EXISTS resources,
    DROP COLUMN IF EXISTS uptime_s,
    DROP COLUMN IF EXISTS process_start_time,
    DROP COLUMN IF EXISTS region,
    DROP COLUMN IF EXISTS platform,
    DROP COLUMN IF EXISTS node_name,
    DROP COLUMN IF EXISTS namespace,
    DROP COLUMN IF EXISTS pod_uid,
    DROP COLUMN IF EXISTS pod_name,
    DROP COLUMN IF EXISTS container_id,
    DROP COLUMN IF EXISTS hostname_guess,
    DROP COLUMN IF EXISTS hostname;
