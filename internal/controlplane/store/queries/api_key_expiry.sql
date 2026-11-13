-- The hourly API key expiry job (internal/controlplane/apikeys/expiry.go).

-- name: LockAPIKeysExpiringSoon :many
-- Keys that stop working after now and no later than until, whose admins
-- were not reminded yet, row-locked (keys another run holds are skipped).
-- Revoked keys, keys in a rotation overlap and keys of deleted projects are
-- never reminded.
SELECT k.id, k.name, k.prefix, k.scopes, k.expires_at::timestamptz AS expires_at,
       p.id AS project_id, p.org_id, p.slug AS project_slug
FROM api_keys k
JOIN projects p ON p.id = k.project_id
WHERE k.expires_at > @now::timestamptz AND k.expires_at <= @until::timestamptz
  AND k.revoked_at IS NULL
  AND k.rotated_to IS NULL
  AND k.expired_recorded_at IS NULL
  AND k.expiry_notified_at IS NULL
  AND p.deleted_at IS NULL
ORDER BY k.expires_at, k.id
LIMIT @batch
FOR UPDATE OF k SKIP LOCKED;

-- name: MarkAPIKeyExpiryNotified :exec
UPDATE api_keys SET expiry_notified_at = @at::timestamptz WHERE id = @id AND expiry_notified_at IS NULL;

-- name: LockAPIKeysExpiredUnrecorded :many
-- Keys whose expires_at has passed and whose api_key.expired event is not
-- written yet, row-locked (keys another run holds are skipped). Revoked
-- keys, rotated keys and keys of deleted projects get no expired event.
SELECT k.id, k.name, k.prefix, k.scopes, k.expires_at::timestamptz AS expires_at,
       p.id AS project_id, p.org_id, p.slug AS project_slug
FROM api_keys k
JOIN projects p ON p.id = k.project_id
WHERE k.expires_at <= @now::timestamptz
  AND k.revoked_at IS NULL
  AND k.rotated_to IS NULL
  AND k.expired_recorded_at IS NULL
  AND p.deleted_at IS NULL
ORDER BY k.expires_at, k.id
LIMIT @batch
FOR UPDATE OF k SKIP LOCKED;

-- name: MarkAPIKeyExpiredRecorded :exec
UPDATE api_keys SET expired_recorded_at = @at::timestamptz WHERE id = @id AND expired_recorded_at IS NULL;
