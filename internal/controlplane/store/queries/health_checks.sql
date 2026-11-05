-- Active HTTP health checks (internal/alerts: the alerts.health_checks job;
-- internal/query: the health check operations).

-- name: CreateHealthCheck :one
INSERT INTO health_checks (id, project_id, app_id, environment, url, expected_status, enabled, created_by)
VALUES (@id, @project_id, @app_id, @environment, @url, @expected_status, @enabled, @created_by)
RETURNING *;

-- name: GetHealthCheck :one
SELECT * FROM health_checks
WHERE project_id = @project_id AND id = @id;

-- name: ListHealthChecks :many
-- The project's checks of active apps, by app, environment and URL.
SELECT h.* FROM health_checks h
JOIN apps a ON a.id = h.app_id
WHERE h.project_id = @project_id AND a.deleted_at IS NULL
ORDER BY a.name, h.environment, h.url, h.id;

-- name: UpdateHealthCheck :one
-- Replaces a check's editable fields. A changed URL or expected status
-- clears the latest result (the check shows as not yet checked); its status
-- and open event stay until the next probe decides.
UPDATE health_checks
SET environment     = @environment,
    url             = @url,
    expected_status = @expected_status,
    enabled         = @enabled,
    checked_at      = CASE WHEN url = @url AND expected_status = @expected_status THEN checked_at END,
    last_result     = CASE WHEN url = @url AND expected_status = @expected_status THEN last_result END,
    updated_at      = now()
WHERE project_id = @project_id AND id = @id
RETURNING *;

-- name: DeleteHealthCheck :execrows
-- Deletes a check and its events.
DELETE FROM health_checks
WHERE project_id = @project_id AND id = @id;

-- name: ListHealthChecksToRun :many
-- Every enabled check of an active app of an active project: what the job
-- probes.
SELECT h.id, h.project_id, h.app_id, h.url, h.expected_status
FROM health_checks h
JOIN apps a ON a.id = h.app_id
JOIN projects p ON p.id = h.project_id
WHERE h.enabled AND a.deleted_at IS NULL AND p.deleted_at IS NULL
ORDER BY h.id;

-- name: LockHealthCheck :one
-- Locks an enabled check for the transaction that records a probe, so two
-- runs cannot step it at once. Returns pgx.ErrNoRows when the check was
-- deleted or disabled since it was listed.
SELECT * FROM health_checks
WHERE id = @id AND enabled
FOR UPDATE;

-- name: RecordHealthCheckResult :exec
-- Records a probe of a check and its status.
UPDATE health_checks
SET status       = @status,
    status_since = @status_since,
    checked_at   = @checked_at::timestamptz,
    last_result  = @last_result,
    updated_at   = now()
WHERE id = @id;

-- name: OpenHealthCheckEvent :one
-- Opens a check's event with the failed request's details. A check has at
-- most one open event, so this fails with a unique violation
-- (alert_events_health_check_open) while one is open.
INSERT INTO alert_events (id, kind, health_check_id, value, started_at, details)
VALUES (@id, 'health_check', @health_check_id::uuid, @value, @started_at, @details)
RETURNING *;

-- name: GetOpenHealthCheckEvent :one
-- A check's open event. Returns pgx.ErrNoRows when none is open.
SELECT * FROM alert_events
WHERE kind = 'health_check' AND health_check_id = @health_check_id::uuid AND state = 'triggered';

-- name: ListHealthCheckEvents :many
-- A check's events, newest first.
SELECT * FROM alert_events
WHERE kind = 'health_check' AND health_check_id = @health_check_id::uuid
ORDER BY started_at DESC, id DESC
LIMIT @lim;

-- name: GetHealthCheckEventNotification :one
-- What a notification about a health check event says: the event (with the
-- failed request's details), its check, app and project, and the channels
-- it goes to, which are every notification channel of the project. Returns
-- pgx.ErrNoRows when the event is not a health check event or was deleted.
SELECT e.id, e.state, e.value, e.started_at, e.ended_at, e.notified_at, e.details,
       h.id AS health_check_id, h.url, h.expected_status, h.environment, h.enabled,
       a.project_id, a.id AS app_id, a.name AS app_name, p.slug AS project_slug,
       ARRAY(SELECT c.id FROM notification_channels c WHERE c.project_id = a.project_id ORDER BY c.name)::uuid[] AS channel_ids
FROM alert_events e
JOIN health_checks h ON h.id = e.health_check_id
JOIN apps a ON a.id = h.app_id
JOIN projects p ON p.id = a.project_id
WHERE e.id = @id AND e.kind = 'health_check';
