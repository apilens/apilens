-- name: InsertAuditEvent :one
-- Records a security-relevant event about a user's account.
INSERT INTO audit_events (user_id, actor_user_id, event, ip, user_agent, metadata)
VALUES (sqlc.narg('user_id'), sqlc.narg('actor_user_id'), @event, sqlc.narg('ip'), @user_agent, @metadata)
RETURNING *;

-- name: ListAuditEventsForUser :many
-- Newest first, keyset-paginated: pass the last row's (created_at, id) as the
-- cursor for the next page, or NULLs for the first page.
SELECT * FROM audit_events
WHERE user_id = @user_id::uuid
  AND (sqlc.narg('before_created_at')::timestamptz IS NULL
       OR (created_at, id) < (sqlc.narg('before_created_at')::timestamptz, sqlc.narg('before_id')::bigint))
ORDER BY created_at DESC, id DESC
LIMIT @page_size;
