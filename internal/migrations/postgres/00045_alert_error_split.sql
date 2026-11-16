-- Alert rules can watch server errors (5xx) and client errors (4xx)
-- separately (#972), besides the combined errors and error_rate (4xx + 5xx)
-- that existing rules keep using unchanged.
--
--   server_errors      requests answered 5xx
--   server_error_rate  server_errors / requests, 0 to 1
--   client_errors      requests answered 4xx
--   client_error_rate  client_errors / requests, 0 to 1

-- +goose Up
ALTER TABLE alert_rules
    DROP CONSTRAINT IF EXISTS alert_rules_metric_check,
    ADD CONSTRAINT alert_rules_metric_check CHECK (metric IN (
        'traffic', 'errors', 'error_rate',
        'server_errors', 'server_error_rate', 'client_errors', 'client_error_rate',
        'p50', 'p75', 'p95', 'apdex', 'unique_consumers'));

-- +goose Down
DELETE FROM alert_rules
    WHERE metric IN ('server_errors', 'server_error_rate', 'client_errors', 'client_error_rate');
ALTER TABLE alert_rules
    DROP CONSTRAINT IF EXISTS alert_rules_metric_check,
    ADD CONSTRAINT alert_rules_metric_check CHECK (metric IN (
        'traffic', 'errors', 'error_rate', 'p50', 'p75', 'p95', 'apdex', 'unique_consumers'));
