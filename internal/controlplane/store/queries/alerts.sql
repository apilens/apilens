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
-- from the newest.
SELECT e.*, r.name AS rule_name, r.app_id, r.environment, r.metric
FROM alert_events e
JOIN alert_rules r ON r.id = e.rule_id
WHERE r.project_id = @project_id
  AND (sqlc.narg(before_started_at)::timestamptz IS NULL
       OR (e.started_at, e.id) < (sqlc.narg(before_started_at)::timestamptz, sqlc.narg(before_id)::uuid))
ORDER BY e.started_at DESC, e.id DESC
LIMIT @row_limit;

-- Alert rule evaluation state.

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

-- name: UpsertAlertRuleState :exec
-- Records the result of a rule's latest evaluation.
INSERT INTO alert_rule_state (rule_id, evaluated_at, window_start, window_end, value, requests, breached)
VALUES (@rule_id, @evaluated_at, @window_start, @window_end, sqlc.narg(value)::float8, @requests, @breached)
ON CONFLICT (rule_id) DO UPDATE
SET evaluated_at = EXCLUDED.evaluated_at,
    window_start = EXCLUDED.window_start,
    window_end   = EXCLUDED.window_end,
    value        = EXCLUDED.value,
    requests     = EXCLUDED.requests,
    breached     = EXCLUDED.breached;

-- name: GetAlertRuleState :one
-- A rule's latest evaluation. Returns pgx.ErrNoRows before the first.
SELECT * FROM alert_rule_state
WHERE rule_id = @rule_id;
