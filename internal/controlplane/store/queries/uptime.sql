-- Uptime from SDK heartbeats (internal/alerts: the alerts.uptime job).

-- name: ListUptimeTargets :many
-- Every environment of an active app of an active project that sent a
-- heartbeat since @since, with its latest heartbeat: what the uptime job
-- checks.
SELECT a.project_id, i.app_id, i.environment, max(i.last_seen_at)::timestamptz AS last_seen_at
FROM app_instances i
JOIN apps a ON a.id = i.app_id
JOIN projects p ON p.id = a.project_id
WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL AND i.last_seen_at >= @since
GROUP BY a.project_id, i.app_id, i.environment
ORDER BY i.app_id, i.environment;

-- name: EnsureUptimeMonitor :one
-- Creates an environment's monitor on first sight (up, never checked) and
-- locks it for the transaction that records a check, so two runs cannot
-- step it at once.
INSERT INTO uptime_monitors (app_id, environment, project_id)
VALUES (@app_id, @environment, @project_id)
ON CONFLICT (app_id, environment) DO UPDATE SET project_id = EXCLUDED.project_id
RETURNING *;

-- name: UpdateUptimeMonitorStatus :exec
-- Records a check of an environment and its uptime status.
UPDATE uptime_monitors
SET status       = @status,
    status_since = @status_since,
    checked_at   = @checked_at::timestamptz,
    updated_at   = now()
WHERE app_id = @app_id AND environment = @environment;

-- name: SetUptimeMonitorMuted :one
-- Mutes or unmutes an environment's uptime notifications, creating its
-- monitor if the job has not checked it yet.
INSERT INTO uptime_monitors (app_id, environment, project_id, muted)
VALUES (@app_id, @environment, @project_id, @muted)
ON CONFLICT (app_id, environment) DO UPDATE SET muted = EXCLUDED.muted, updated_at = now()
RETURNING *;

-- name: GetUptimeMonitor :one
-- An environment's monitor. Returns pgx.ErrNoRows before the job first
-- sees the environment (and while it was never muted).
SELECT * FROM uptime_monitors
WHERE app_id = @app_id AND environment = @environment;

-- name: OpenUptimeEvent :one
-- Opens an uptime event for an environment. An environment has at most one
-- open uptime event, so this fails with a unique violation
-- (alert_events_uptime_open) while one is open.
INSERT INTO alert_events (id, kind, monitor_app_id, monitor_environment, value, started_at)
VALUES (@id, 'uptime', @app_id::uuid, @environment::text, @value, @started_at)
RETURNING *;

-- name: GetOpenUptimeEvent :one
-- An environment's open uptime event. Returns pgx.ErrNoRows when none is
-- open.
SELECT * FROM alert_events
WHERE kind = 'uptime' AND monitor_app_id = @app_id::uuid AND monitor_environment = @environment::text AND state = 'triggered';

-- name: GetUptimeEventNotification :one
-- What a notification about an uptime event says: the event, its app,
-- project and monitor (muted), and the channels it goes to, which are every
-- notification channel of the project. Returns pgx.ErrNoRows when the event
-- is not an uptime event or was deleted.
SELECT e.id, e.state, e.value, e.started_at, e.ended_at, e.notified_at,
       m.environment, m.muted, a.project_id, a.id AS app_id, a.name AS app_name, p.slug AS project_slug,
       ARRAY(SELECT c.id FROM notification_channels c WHERE c.project_id = a.project_id ORDER BY c.name)::uuid[] AS channel_ids
FROM alert_events e
JOIN uptime_monitors m ON m.app_id = e.monitor_app_id AND m.environment = e.monitor_environment
JOIN apps a ON a.id = e.monitor_app_id
JOIN projects p ON p.id = a.project_id
WHERE e.id = @id AND e.kind = 'uptime';
