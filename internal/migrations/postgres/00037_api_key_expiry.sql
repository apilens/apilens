-- API key expiry reminders and the api_key.expired audit event (#799).
--
--   expiry_notified_at   when the project admins were emailed that the key
--                        expires within 7 days. Set once by the hourly
--                        apikeys.expiry job, so each key is reminded at most
--                        once. Keys in a rotation overlap (rotated_to set)
--                        are never reminded: the rotation already says when
--                        the old secret stops working.
--   expired_recorded_at  when the job wrote api_key.expired for the key
--                        after its expires_at passed; set once, so the event
--                        is written once. Revoked and rotated keys get no
--                        expired event (api_key.revoked and api_key.rotated
--                        already record when they stop working).
--
-- The partial index holds only the keys the job may still act on, so the
-- hourly scan stays small however many keys have expired, been revoked or
-- been rotated.

-- +goose Up
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS expiry_notified_at  timestamptz,
    ADD COLUMN IF NOT EXISTS expired_recorded_at timestamptz;

CREATE INDEX IF NOT EXISTS api_keys_expiry_pending ON api_keys (expires_at)
    WHERE expires_at IS NOT NULL AND revoked_at IS NULL AND rotated_to IS NULL
      AND expired_recorded_at IS NULL;

-- +goose Down
DROP INDEX IF EXISTS api_keys_expiry_pending;
ALTER TABLE api_keys
    DROP COLUMN IF EXISTS expired_recorded_at,
    DROP COLUMN IF EXISTS expiry_notified_at;
