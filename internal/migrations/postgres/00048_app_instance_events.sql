-- Restarts and OOMKills of SDK processes (M7, ADR 0010 D10), inferred at
-- the edge because a killed process cannot report its own end:
--
--   oom_kill       a live process reported its container's OOM killer fired
--                  (cgroup memory.events oom_kill delta); details.count
--   restart        a process ended and was replaced, cause unknown
--   oom            a process ended after its container recorded an OOM kill
--   suspected_oom  a process ended with its container at >= 90 % of its
--                  memory limit
--
-- One row per event, read by the instance-events API for chart markers.

-- +goose Up
CREATE TABLE IF NOT EXISTS app_instance_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id   uuid        NOT NULL REFERENCES projects (id),
    app_id       uuid        NOT NULL REFERENCES apps (id),
    environment  text        NOT NULL,
    instance_id  text        NOT NULL,
    container_id text        NOT NULL DEFAULT '',
    pod_name     text        NOT NULL DEFAULT '',
    kind         text        NOT NULL CHECK (kind IN ('restart', 'oom', 'suspected_oom', 'oom_kill')),
    at           timestamptz NOT NULL,
    details      jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS app_instance_events_app_at ON app_instance_events (app_id, environment, at DESC);
CREATE INDEX IF NOT EXISTS app_instance_events_project ON app_instance_events (project_id);

-- +goose Down
DROP TABLE IF EXISTS app_instance_events;
