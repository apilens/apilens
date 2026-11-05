-- Evaluation state of alert rules: the result of each rule's latest
-- evaluation (internal/alerts: the alerts.evaluate River job).
--
--   alert_rules 1 ── 0..1 alert_rule_state.rule_id
--
-- evaluated_at is when the rule was last evaluated; the job evaluates a rule
-- again once every_s has passed since then, or at the next tick of its cron
-- schedule after it. window_start/window_end are the minute-aligned window
-- the value was aggregated over (window_end exclusive). value is NULL when
-- the window has no data for the metric (no requests for a rate, percentile
-- or Apdex). requests is how many requests the window counted. breached is
-- whether value compared to the threshold by the rule's condition; a NULL
-- value never breaches.

-- +goose Up
CREATE TABLE IF NOT EXISTS alert_rule_state (
    rule_id       uuid PRIMARY KEY REFERENCES alert_rules (id) ON DELETE CASCADE,
    evaluated_at  timestamptz NOT NULL,
    window_start  timestamptz NOT NULL,
    window_end    timestamptz NOT NULL,
    value         float8,
    requests      bigint      NOT NULL DEFAULT 0 CHECK (requests >= 0),
    breached      boolean     NOT NULL,
    CONSTRAINT alert_rule_state_window CHECK (window_start < window_end),
    CONSTRAINT alert_rule_state_no_data CHECK (value IS NOT NULL OR NOT breached)
);

-- +goose Down
DROP TABLE IF EXISTS alert_rule_state;
