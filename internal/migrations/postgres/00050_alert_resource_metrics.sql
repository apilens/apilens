-- Alert rules can watch runtime resources (M7, #1135), read from the SDK
-- heartbeats (ClickHouse app_instance_resources) and the inferred instance
-- events (app_instance_events) instead of requests:
--
--   cpu_pct_of_limit     CPU % of the limit (container, else process), 0-100
--   memory_pct_of_limit  container working set % of its memory limit, 0-100
--   cpu_throttled_ratio  throttled CPU periods / periods, 0 to 1
--   event_loop_p99_ms    Node.js event-loop delay p99, ms
--   gc_pause_pct         GC pause time % of the heartbeat window, 0-100
--   oom_kills            OOM kills of the containers, each counted once
--   restarts             inferred restarts (restart, oom, suspected_oom)
--
-- aggregation is how a gauge combines over instances: max (the default,
-- what every existing rule keeps) or avg. Request metrics and the counts
-- ignore it.

-- +goose Up
ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS aggregation text NOT NULL DEFAULT 'max'
        CONSTRAINT alert_rules_aggregation_check CHECK (aggregation IN ('max', 'avg'));
ALTER TABLE alert_rules
    DROP CONSTRAINT IF EXISTS alert_rules_metric_check,
    ADD CONSTRAINT alert_rules_metric_check CHECK (metric IN (
        'traffic', 'errors', 'error_rate',
        'server_errors', 'server_error_rate', 'client_errors', 'client_error_rate',
        'p50', 'p75', 'p95', 'apdex', 'unique_consumers',
        'cpu_pct_of_limit', 'memory_pct_of_limit', 'cpu_throttled_ratio',
        'event_loop_p99_ms', 'gc_pause_pct', 'oom_kills', 'restarts'));

-- +goose Down
DELETE FROM alert_rules
    WHERE metric IN ('cpu_pct_of_limit', 'memory_pct_of_limit', 'cpu_throttled_ratio',
                     'event_loop_p99_ms', 'gc_pause_pct', 'oom_kills', 'restarts');
ALTER TABLE alert_rules
    DROP CONSTRAINT IF EXISTS alert_rules_metric_check,
    ADD CONSTRAINT alert_rules_metric_check CHECK (metric IN (
        'traffic', 'errors', 'error_rate',
        'server_errors', 'server_error_rate', 'client_errors', 'client_error_rate',
        'p50', 'p75', 'p95', 'apdex', 'unique_consumers'));
ALTER TABLE alert_rules DROP COLUMN IF EXISTS aggregation;
