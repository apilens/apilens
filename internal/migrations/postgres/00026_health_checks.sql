-- Active HTTP health checks (internal/alerts: the alerts.health_checks
-- River job). Every minute the job sends GET to each enabled check's URL
-- (5 s timeout, one retry) and compares the response status to
-- expected_status; a check that still fails after the retry is down.
--
--   projects 1 ── * health_checks.project_id
--   apps 1 ── * health_checks.app_id
--   health_checks 1 ── * alert_events.health_check_id (kind health_check)
--
-- health_checks: one URL of an app environment. status is up or down and
-- status_since when it entered it; checked_at is the job's latest probe
-- (NULL before the first) and last_result what that probe saw (the same
-- shape as alert_events.details). URLs must be http(s) to a public address
-- unless the install allows private networks
-- (alerts.health_checks_allow_private).
--
-- alert_events gains kind health_check: an event of a check
-- (health_check_id) opens when the check goes down and resolves when it
-- passes again. value is the latency in ms of the failed attempt and
-- details the failed request: {"status_code", "latency_ms", "error",
-- "body_snippet" (at most 1 KiB, masked by the privacy policy),
-- "body_truncated", "attempts", "checked_at"}. A check has at most one open
-- event.

-- +goose Up
CREATE TABLE IF NOT EXISTS health_checks (
    id              uuid PRIMARY KEY,
    project_id      uuid        NOT NULL REFERENCES projects (id),
    app_id          uuid        NOT NULL REFERENCES apps (id),
    environment     text        NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
    url             text        NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
    expected_status integer     NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
    enabled         boolean     NOT NULL DEFAULT true,
    status          text        NOT NULL DEFAULT 'up' CHECK (status IN ('up', 'down')),
    status_since    timestamptz NOT NULL DEFAULT now(),
    checked_at      timestamptz,
    last_result     jsonb       CHECK (jsonb_typeof(last_result) = 'object'),
    created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_checks_project ON health_checks (project_id);

ALTER TABLE alert_events
    ADD COLUMN IF NOT EXISTS health_check_id uuid REFERENCES health_checks (id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS details jsonb CHECK (jsonb_typeof(details) = 'object'),
    DROP CONSTRAINT IF EXISTS alert_events_kind_check,
    ADD CONSTRAINT alert_events_kind_check CHECK (kind IN ('threshold', 'uptime', 'health_check')),
    DROP CONSTRAINT IF EXISTS alert_events_kind_scope,
    ADD CONSTRAINT alert_events_kind_scope CHECK (CASE kind
        WHEN 'threshold' THEN rule_id IS NOT NULL AND health_check_id IS NULL
        WHEN 'uptime' THEN rule_id IS NULL AND health_check_id IS NULL
            AND monitor_app_id IS NOT NULL AND monitor_environment IS NOT NULL
        ELSE rule_id IS NULL AND monitor_app_id IS NULL AND health_check_id IS NOT NULL END);
-- At most one open event per health check.
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_health_check_open
    ON alert_events (health_check_id) WHERE kind = 'health_check' AND state = 'triggered';
CREATE INDEX IF NOT EXISTS alert_events_health_check_started
    ON alert_events (health_check_id, started_at DESC) WHERE kind = 'health_check';

-- +goose Down
DELETE FROM alert_events WHERE kind = 'health_check';
DROP INDEX IF EXISTS alert_events_health_check_started;
DROP INDEX IF EXISTS alert_events_health_check_open;
ALTER TABLE alert_events
    DROP CONSTRAINT IF EXISTS alert_events_kind_scope,
    ADD CONSTRAINT alert_events_kind_scope CHECK (CASE kind
        WHEN 'threshold' THEN rule_id IS NOT NULL
        ELSE rule_id IS NULL AND monitor_app_id IS NOT NULL AND monitor_environment IS NOT NULL END),
    DROP CONSTRAINT IF EXISTS alert_events_kind_check,
    ADD CONSTRAINT alert_events_kind_check CHECK (kind IN ('threshold', 'uptime')),
    DROP COLUMN IF EXISTS details,
    DROP COLUMN IF EXISTS health_check_id;
DROP TABLE IF EXISTS health_checks;
