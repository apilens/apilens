-- Uptime from SDK heartbeats (internal/alerts: the alerts.uptime River
-- job). An app's environment is down when none of its instances has sent a
-- heartbeat (app_instances.last_seen_at) for three heartbeat intervals.
--
--   apps 1 ── * uptime_monitors.app_id (one per environment)
--   apps 1 ── * alert_events.monitor_app_id (kind uptime)
--
-- uptime_monitors: the uptime state of one app environment, created by the
-- job the first time it sees the environment's heartbeats. status is up or
-- down and status_since when it entered it (the last heartbeat before the
-- gap while down; the heartbeat that ended it while up). checked_at is the
-- job's latest check (NULL before the first): an environment first checked
-- while already down opens no event, since it was never seen up. muted
-- turns off the environment's uptime notifications; events are still
-- recorded.
--
-- alert_events gains a kind: threshold events belong to an alert rule
-- (rule_id); uptime events to an app environment (monitor_app_id,
-- monitor_environment), with value the seconds since the last heartbeat
-- when the gap was detected, started_at the last heartbeat and ended_at the
-- latest heartbeat when the job saw it again. An environment has at most one open uptime event.

-- +goose Up
CREATE TABLE IF NOT EXISTS uptime_monitors (
    app_id       uuid        NOT NULL REFERENCES apps (id),
    environment  text        NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
    project_id   uuid        NOT NULL REFERENCES projects (id),
    muted        boolean     NOT NULL DEFAULT false,
    status       text        NOT NULL DEFAULT 'up' CHECK (status IN ('up', 'down')),
    status_since timestamptz NOT NULL DEFAULT now(),
    checked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, environment)
);
CREATE INDEX IF NOT EXISTS uptime_monitors_project ON uptime_monitors (project_id);

ALTER TABLE alert_events
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'threshold' CHECK (kind IN ('threshold', 'uptime')),
    ADD COLUMN IF NOT EXISTS monitor_app_id uuid REFERENCES apps (id),
    ADD COLUMN IF NOT EXISTS monitor_environment text CHECK (length(monitor_environment) BETWEEN 1 AND 64),
    ALTER COLUMN rule_id DROP NOT NULL,
    ADD CONSTRAINT alert_events_kind_scope CHECK (CASE kind
        WHEN 'threshold' THEN rule_id IS NOT NULL
        ELSE rule_id IS NULL AND monitor_app_id IS NOT NULL AND monitor_environment IS NOT NULL END);
-- At most one open uptime event per app environment.
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_uptime_open
    ON alert_events (monitor_app_id, monitor_environment) WHERE kind = 'uptime' AND state = 'triggered';
CREATE INDEX IF NOT EXISTS alert_events_uptime_started
    ON alert_events (monitor_app_id, monitor_environment, started_at DESC) WHERE kind = 'uptime';

-- +goose Down
DELETE FROM alert_events WHERE kind <> 'threshold';
DROP INDEX IF EXISTS alert_events_uptime_started;
DROP INDEX IF EXISTS alert_events_uptime_open;
ALTER TABLE alert_events
    DROP CONSTRAINT IF EXISTS alert_events_kind_scope,
    ALTER COLUMN rule_id SET NOT NULL,
    DROP COLUMN IF EXISTS monitor_environment,
    DROP COLUMN IF EXISTS monitor_app_id,
    DROP COLUMN IF EXISTS kind;
DROP TABLE IF EXISTS uptime_monitors;
