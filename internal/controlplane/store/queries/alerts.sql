-- Notification channels. config_enc is the channel's JSON config sealed with
-- the identity key-encryption key (internal/alerts: SealChannelConfig); it is
-- never returned by the API.

-- name: CreateNotificationChannel :one
INSERT INTO notification_channels (id, project_id, type, name, config_enc, created_by)
VALUES (@id, @project_id, @type, @name, @config_enc, @created_by)
RETURNING *;

-- name: GetNotificationChannel :one
-- One channel of a project. Returns pgx.ErrNoRows when the project has no
-- such channel.
SELECT * FROM notification_channels
WHERE project_id = @project_id AND id = @id;

-- name: ListNotificationChannels :many
SELECT * FROM notification_channels
WHERE project_id = @project_id
ORDER BY name;

-- name: ListNotificationChannelsByIDs :many
-- The channels a rule notifies (alert_rules.channel_ids), for sending.
-- Channels of other projects are never returned.
SELECT * FROM notification_channels
WHERE project_id = @project_id AND id = ANY(@ids::uuid[])
ORDER BY name;

-- name: UpdateNotificationChannel :one
-- Renames a channel and replaces its sealed config. The type never changes.
UPDATE notification_channels
SET name       = @name,
    config_enc = @config_enc,
    updated_at = now()
WHERE project_id = @project_id AND id = @id
RETURNING *;

-- name: DeleteNotificationChannel :execrows
DELETE FROM notification_channels
WHERE project_id = @project_id AND id = @id;

-- name: RemoveChannelFromAlertRules :execrows
-- Drops a deleted channel from every rule of its project that notifies it.
-- Run in the same transaction as DeleteNotificationChannel.
UPDATE alert_rules
SET channel_ids = array_remove(channel_ids, @channel_id::uuid),
    updated_at  = now()
WHERE project_id = @project_id AND channel_ids @> ARRAY[@channel_id::uuid];

-- Alert rules.

-- name: CreateAlertRule :one
INSERT INTO alert_rules (id, project_id, app_id, environment, name, description, metric, condition,
                         threshold, window_s, every_s, cron, notify_after_s, resolve_after_s,
                         filters, channel_ids, enabled, created_by)
VALUES (@id, @project_id, @app_id, @environment, @name, @description, @metric, @condition,
        @threshold, @window_s, sqlc.narg(every_s)::integer, sqlc.narg(cron)::text, @notify_after_s,
        @resolve_after_s, @filters, @channel_ids, @enabled, @created_by)
RETURNING *;

-- name: GetAlertRule :one
-- One rule of a project. Returns pgx.ErrNoRows when the project has no such
-- rule.
SELECT * FROM alert_rules
WHERE project_id = @project_id AND id = @id;

-- name: ListAlertRules :many
-- A project's rules; rules of deleted apps are skipped.
SELECT r.* FROM alert_rules r
JOIN apps a ON a.id = r.app_id
WHERE r.project_id = @project_id AND a.deleted_at IS NULL
ORDER BY r.name, r.id;

-- name: ListEnabledAlertRules :many
-- Every enabled rule of an active app of an active project: what the
-- evaluator runs.
SELECT r.* FROM alert_rules r
JOIN apps a ON a.id = r.app_id
JOIN projects p ON p.id = r.project_id
WHERE r.enabled AND a.deleted_at IS NULL AND p.deleted_at IS NULL
ORDER BY r.id;

-- name: UpdateAlertRule :one
-- Replaces every editable field of a rule. The app and project never change.
UPDATE alert_rules
SET environment     = @environment,
    name            = @name,
    description     = @description,
    metric          = @metric,
    condition       = @condition,
    threshold       = @threshold,
    window_s        = @window_s,
    every_s         = sqlc.narg(every_s)::integer,
    cron            = sqlc.narg(cron)::text,
    notify_after_s  = @notify_after_s,
    resolve_after_s = @resolve_after_s,
    filters         = @filters,
    channel_ids     = @channel_ids,
    enabled         = @enabled,
    updated_at      = now()
WHERE project_id = @project_id AND id = @id
RETURNING *;

-- name: DeleteAlertRule :execrows
-- Deletes a rule and, by cascade, its events.
DELETE FROM alert_rules
WHERE project_id = @project_id AND id = @id;

-- Alert events.

-- name: OpenAlertEvent :one
-- Opens a triggered event for a rule. A rule has at most one open event, so
-- this fails with a unique violation (alert_events_open) while one is open.
INSERT INTO alert_events (id, rule_id, value, started_at)
VALUES (@id, @rule_id, @value, @started_at)
RETURNING *;

-- name: GetOpenAlertEvent :one
-- A rule's open (triggered) event. Returns pgx.ErrNoRows when none is open.
SELECT * FROM alert_events
WHERE rule_id = @rule_id AND state = 'triggered';

-- name: MarkAlertEventNotified :execrows
-- Records the first notification of an event; later calls change nothing.
UPDATE alert_events
SET notified_at = @notified_at::timestamptz
WHERE id = @id AND notified_at IS NULL;

-- name: GetAlertEventNotification :one
-- What a notification about an event says: the event, its rule, app and
-- project, and the rule's latest evaluated value (NULL before the first or
-- when the window had no data). Returns pgx.ErrNoRows when the event (or its
-- rule) was deleted.
SELECT e.id, e.state, e.value, e.started_at, e.ended_at, e.notified_at,
       r.id AS rule_id, r.project_id, r.name AS rule_name, r.environment, r.metric, r.condition,
       r.threshold, r.window_s, r.channel_ids,
       a.id AS app_id, a.name AS app_name, p.slug AS project_slug,
       s.value AS latest_value
FROM alert_events e
JOIN alert_rules r ON r.id = e.rule_id
JOIN apps a ON a.id = r.app_id
JOIN projects p ON p.id = r.project_id
LEFT JOIN alert_rule_state s ON s.rule_id = r.id
WHERE e.id = @id;

-- name: ResolveAlertEvent :one
-- Resolves an open event. Returns pgx.ErrNoRows when it is not open.
UPDATE alert_events
SET state    = 'resolved',
    ended_at = @ended_at::timestamptz
WHERE id = @id AND state = 'triggered'
RETURNING *;

-- name: ListAlertEvents :many
-- A project's incidents feed, newest first, with the rule each belongs to.
-- Pass the last row's started_at and id as the cursor to page; NULLs start
-- from the newest. rule_id and state narrow the feed when set.
SELECT e.*, r.name AS rule_name, r.app_id, r.environment, r.metric
FROM alert_events e
JOIN alert_rules r ON r.id = e.rule_id
WHERE r.project_id = @project_id
  AND (sqlc.narg(rule_id)::uuid IS NULL OR e.rule_id = sqlc.narg(rule_id)::uuid)
  AND (sqlc.narg(state)::text IS NULL OR e.state = sqlc.narg(state)::text)
  AND (sqlc.narg(before_started_at)::timestamptz IS NULL
       OR (e.started_at, e.id) < (sqlc.narg(before_started_at)::timestamptz, sqlc.narg(before_id)::uuid))
ORDER BY e.started_at DESC, e.id DESC
LIMIT @row_limit;

-- name: ListAlertIncidents :many
-- A project's events grouped by rule: one row per rule of an active app
-- with an event started at or after since, or one still open, with how
-- many such events it has, its latest event and its trigger/resolve status
-- ('ok' before the first evaluation). Rules with an open event come first,
-- then by their latest event, newest first.
SELECT r.id AS rule_id, r.name AS rule_name, r.app_id, r.environment, r.metric, r.condition, r.threshold,
       COALESCE(s.status, 'ok')::text AS status,
       g.events, g.first_started_at::timestamptz AS first_started_at,
       l.id AS latest_event_id, l.state AS latest_state, l.value AS latest_value,
       l.started_at AS latest_started_at, l.ended_at AS latest_ended_at, l.notified_at AS latest_notified_at
FROM alert_rules r
JOIN apps a ON a.id = r.app_id AND a.deleted_at IS NULL
JOIN LATERAL (
    SELECT count(*) AS events, min(e.started_at) AS first_started_at
    FROM alert_events e
    WHERE e.rule_id = r.id AND (e.started_at >= @since::timestamptz OR e.state = 'triggered')
) g ON g.events > 0
JOIN LATERAL (
    SELECT e.id, e.state, e.value, e.started_at, e.ended_at, e.notified_at
    FROM alert_events e
    WHERE e.rule_id = r.id
    ORDER BY e.started_at DESC, e.id DESC
    LIMIT 1
) l ON true
LEFT JOIN alert_rule_state s ON s.rule_id = r.id
WHERE r.project_id = @project_id
ORDER BY (l.state = 'triggered') DESC, l.started_at DESC, r.id
LIMIT @row_limit;

-- Alert rule evaluation state.

-- name: ListAlertRuleStates :many
-- The latest evaluation of every evaluated rule of a project.
SELECT s.* FROM alert_rule_state s
JOIN alert_rules r ON r.id = s.rule_id
WHERE r.project_id = @project_id;

-- name: ListAlertRulesToEvaluate :many
-- Every enabled rule of an active app of an active project with when it was
-- last evaluated (NULL when never): what the evaluation job considers.
SELECT r.*, s.evaluated_at AS last_evaluated_at
FROM alert_rules r
JOIN apps a ON a.id = r.app_id
JOIN projects p ON p.id = r.project_id
LEFT JOIN alert_rule_state s ON s.rule_id = r.id
WHERE r.enabled AND a.deleted_at IS NULL AND p.deleted_at IS NULL
ORDER BY r.id;

-- name: LockAlertRule :one
-- Locks a rule for the transaction that records its evaluation, so two runs
-- cannot step its state at once. Returns pgx.ErrNoRows when the rule was
-- deleted.
SELECT id FROM alert_rules
WHERE id = @id
FOR NO KEY UPDATE;

-- name: UpsertAlertRuleState :exec
-- Records the result of a rule's latest evaluation and its trigger/resolve
-- state.
INSERT INTO alert_rule_state (rule_id, evaluated_at, window_start, window_end, value, requests, breached,
                              status, status_since)
VALUES (@rule_id, @evaluated_at, @window_start, @window_end, sqlc.narg(value)::float8, @requests, @breached,
        @status, @status_since)
ON CONFLICT (rule_id) DO UPDATE
SET evaluated_at = EXCLUDED.evaluated_at,
    window_start = EXCLUDED.window_start,
    window_end   = EXCLUDED.window_end,
    value        = EXCLUDED.value,
    requests     = EXCLUDED.requests,
    breached     = EXCLUDED.breached,
    status       = EXCLUDED.status,
    status_since = EXCLUDED.status_since;

-- name: GetAlertRuleState :one
-- A rule's latest evaluation. Returns pgx.ErrNoRows before the first.
SELECT * FROM alert_rule_state
WHERE rule_id = @rule_id;
