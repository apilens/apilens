-- Trigger/resolve state of alert rules (internal/alerts: Step). Each
-- evaluation moves a rule through
--
--   ok ──breach──> pending ──held notify_after_s──> triggered
--   triggered ──clear──> resolving ──held resolve_after_s──> ok
--
-- pending falls back to ok when the breach clears before notify_after_s;
-- resolving goes back to triggered when the rule breaches again before
-- resolve_after_s. A zero delay skips the intermediate state. Entering
-- triggered opens an alert_events row (notified_at NULL until a channel
-- sends it) and returning to ok resolves that row, in the same transaction
-- as the state write.
--
-- status is the rule's state and status_since when it entered it: the
-- start of the breach while pending, the start of the clear while
-- resolving. Rules evaluated before this migration start in ok.

-- +goose Up
ALTER TABLE alert_rule_state
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok'
        CHECK (status IN ('ok', 'pending', 'triggered', 'resolving')),
    ADD COLUMN IF NOT EXISTS status_since timestamptz;
UPDATE alert_rule_state SET status_since = evaluated_at WHERE status_since IS NULL;
ALTER TABLE alert_rule_state ALTER COLUMN status_since SET NOT NULL;

-- +goose Down
ALTER TABLE alert_rule_state
    DROP COLUMN IF EXISTS status_since,
    DROP COLUMN IF EXISTS status;
