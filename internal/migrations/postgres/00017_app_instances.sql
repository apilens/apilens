-- App instances: one row per SDK process (instance_id) of an app in an
-- environment, upserted by every heartbeat (POST /v1/heartbeat). last_seen_at
-- says whether the app is reporting; stats is the SDK's own counters (queue
-- depth, records sent and dropped), stored as sent. A process restart reports
-- a new instance_id, so old rows simply stop being refreshed.

-- +goose Up
CREATE TABLE IF NOT EXISTS app_instances (
    app_id        uuid        NOT NULL REFERENCES apps (id),
    environment   text        NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
    instance_id   text        NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 128),
    project_id    uuid        NOT NULL REFERENCES projects (id),
    sdk_name      text        NOT NULL DEFAULT '',
    sdk_version   text        NOT NULL DEFAULT '',
    runtime       text        NOT NULL DEFAULT '',
    release       text        NOT NULL DEFAULT '',
    commit        text        NOT NULL DEFAULT '',
    pid           bigint,
    stats         jsonb       NOT NULL DEFAULT '{}',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, environment, instance_id)
);
CREATE INDEX IF NOT EXISTS app_instances_last_seen ON app_instances (app_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS app_instances_project ON app_instances (project_id);

-- +goose Down
DROP TABLE IF EXISTS app_instances;
