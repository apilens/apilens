-- API keys record who created them and what last used them, for access
-- reviews (#773).
--
--   created_by     the user who created the key. NULL for keys created
--                  before this migration with no api_key.created audit row,
--                  and after the creator's account is purged (SET NULL).
--   last_used_sdk  the SDK name and version (first User-Agent product token)
--                  of the last ingest request, e.g. "apilenss/0.5.0".
--   last_used_ip   the client IP of the last ingest request. Personal data:
--                  written only while ingest.record_key_ip is true.
--
-- Both last-use columns are written with last_used_at, under the same
-- per-key throttle, so recording them adds no write per request.

-- +goose Up
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_used_sdk text CHECK (length(last_used_sdk) <= 128),
    ADD COLUMN IF NOT EXISTS last_used_ip inet;

-- Backfill the creator from the api_key.created audit events (actor, by
-- metadata.key_id); the first event wins.
UPDATE api_keys k
SET created_by = e.actor_user_id
FROM (
    SELECT DISTINCT ON (metadata->>'key_id') metadata->>'key_id' AS key_id, actor_user_id
    FROM audit_events
    WHERE event = 'api_key.created' AND actor_user_id IS NOT NULL
    ORDER BY metadata->>'key_id', id
) e
WHERE k.created_by IS NULL
  AND e.key_id = k.id::text
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = e.actor_user_id);

-- +goose Down
ALTER TABLE api_keys
    DROP COLUMN IF EXISTS last_used_ip,
    DROP COLUMN IF EXISTS last_used_sdk,
    DROP COLUMN IF EXISTS created_by;
