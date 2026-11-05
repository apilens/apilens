-- Alerting schema: threshold rules over api_requests_1m, the channels their
-- notifications go to, and the events (incidents) a rule raises.
--
--   projects 1 ── * notification_channels.project_id
--   projects 1 ── * alert_rules.project_id
--   alert_rules.channel_ids ──> notification_channels.id
--   alert_rules 1 ── * alert_events.rule_id
--
-- notification_channels: where a project's alert notifications go (type
-- email, slack, teams or webhook). config_enc is the channel's JSON config
-- (recipient addresses, Slack/Teams/webhook URLs, signing secrets) sealed
-- with the identity key-encryption key and bound to the channel id
-- (internal/alerts: SealChannelConfig). A webhook URL is a bearer secret, so
-- no part of the config is stored in the clear.
--
-- alert_rules: one threshold rule scoped to an app and environment. The rule
-- fires when metric, aggregated over the trailing window_s seconds, compares
-- to threshold by condition. It is evaluated every every_s seconds, or on the
-- cron schedule when cron is set (exactly one of the two is set).
-- notify_after_s is how long the condition must hold before the first
-- notification and resolve_after_s how long it must clear before the event
-- resolves. filters narrows the requests counted:
-- {"consumer": ..., "group": ..., "endpoint": ...}, every key optional.
-- channel_ids are the notification_channels the rule notifies; deleting a
-- channel removes it from every rule (RemoveChannelFromAlertRules).
--
-- alert_events: one per incident. An event opens in state triggered and
-- moves to resolved with ended_at set; a rule has at most one open
-- (triggered) event. value is the metric value that triggered it, and
-- notified_at the time the first notification went out (NULL until then).

-- +goose Up
CREATE TABLE IF NOT EXISTS notification_channels (
    id          uuid PRIMARY KEY,
    project_id  uuid        NOT NULL REFERENCES projects (id),
    type        text        NOT NULL CHECK (type IN ('email', 'slack', 'teams', 'webhook')),
    name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    config_enc  bytea       NOT NULL CHECK (length(config_enc) > 0),
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_project_name
    ON notification_channels (project_id, name);

CREATE TABLE IF NOT EXISTS alert_rules (
    id               uuid PRIMARY KEY,
    project_id       uuid        NOT NULL REFERENCES projects (id),
    app_id           uuid        NOT NULL REFERENCES apps (id),
    environment      text        NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
    name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    description      text        NOT NULL DEFAULT '',
    metric           text        NOT NULL CHECK (metric IN (
        'traffic', 'errors', 'error_rate', 'p50', 'p75', 'p95', 'apdex', 'unique_consumers')),
    condition        text        NOT NULL CHECK (condition IN ('gt', 'gte', 'lt', 'lte')),
    threshold        float8      NOT NULL,
    window_s         integer     NOT NULL CHECK (window_s BETWEEN 60 AND 86400),
    every_s          integer     CHECK (every_s BETWEEN 60 AND 86400),
    cron             text        CHECK (length(cron) BETWEEN 1 AND 128),
    notify_after_s   integer     NOT NULL DEFAULT 0 CHECK (notify_after_s BETWEEN 0 AND 86400),
    resolve_after_s  integer     NOT NULL DEFAULT 0 CHECK (resolve_after_s BETWEEN 0 AND 86400),
    filters          jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
    channel_ids      uuid[]      NOT NULL DEFAULT '{}',
    enabled          boolean     NOT NULL DEFAULT true,
    created_by       uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alert_rules_schedule CHECK ((every_s IS NULL) <> (cron IS NULL))
);
CREATE INDEX IF NOT EXISTS alert_rules_project ON alert_rules (project_id);
-- "Which rules notify this channel?" (forgetting a deleted channel).
CREATE INDEX IF NOT EXISTS alert_rules_channel_ids
    ON alert_rules USING gin (channel_ids);

CREATE TABLE IF NOT EXISTS alert_events (
    id           uuid PRIMARY KEY,
    rule_id      uuid        NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
    state        text        NOT NULL DEFAULT 'triggered' CHECK (state IN ('triggered', 'resolved')),
    value        float8      NOT NULL,
    started_at   timestamptz NOT NULL DEFAULT now(),
    ended_at     timestamptz,
    notified_at  timestamptz,
    CONSTRAINT alert_events_ended CHECK ((state = 'resolved') = (ended_at IS NOT NULL))
);
-- At most one open event per rule.
CREATE UNIQUE INDEX IF NOT EXISTS alert_events_open
    ON alert_events (rule_id) WHERE state = 'triggered';
CREATE INDEX IF NOT EXISTS alert_events_rule_started
    ON alert_events (rule_id, started_at DESC);

-- +goose Down
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS alert_rules;
DROP TABLE IF EXISTS notification_channels;
