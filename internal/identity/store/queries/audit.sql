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

-- name: ListAuditEventsForOrg :many
-- An organization's events (its projects' included), newest first,
-- keyset-paginated like ListAuditEventsForUser. Optional filters: actor,
-- event prefix ('member.' or 'api_key.created'), and a [from, to) time range.
-- Served by audit_events_org_created.
SELECT * FROM audit_events
WHERE org_id = @org_id::uuid
  AND (sqlc.narg('actor_user_id')::uuid IS NULL OR actor_user_id = sqlc.narg('actor_user_id')::uuid)
  AND (sqlc.narg('event_prefix')::text IS NULL OR starts_with(event, sqlc.narg('event_prefix')::text))
  AND (sqlc.narg('from_time')::timestamptz IS NULL OR created_at >= sqlc.narg('from_time')::timestamptz)
  AND (sqlc.narg('to_time')::timestamptz IS NULL OR created_at < sqlc.narg('to_time')::timestamptz)
  AND (sqlc.narg('before_created_at')::timestamptz IS NULL
       OR (created_at, id) < (sqlc.narg('before_created_at')::timestamptz, sqlc.narg('before_id')::bigint))
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: ListAuditEventsForProject :many
-- A project's events, newest first, keyset-paginated and filtered like
-- ListAuditEventsForOrg. Served by audit_events_project_created.
SELECT * FROM audit_events
WHERE project_id = @project_id::uuid
  AND (sqlc.narg('actor_user_id')::uuid IS NULL OR actor_user_id = sqlc.narg('actor_user_id')::uuid)
  AND (sqlc.narg('event_prefix')::text IS NULL OR starts_with(event, sqlc.narg('event_prefix')::text))
  AND (sqlc.narg('from_time')::timestamptz IS NULL OR created_at >= sqlc.narg('from_time')::timestamptz)
  AND (sqlc.narg('to_time')::timestamptz IS NULL OR created_at < sqlc.narg('to_time')::timestamptz)
  AND (sqlc.narg('before_created_at')::timestamptz IS NULL
       OR (created_at, id) < (sqlc.narg('before_created_at')::timestamptz, sqlc.narg('before_id')::bigint))
ORDER BY created_at DESC, id DESC
LIMIT @page_size;
