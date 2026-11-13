-- name: InsertAuditEvent :one
-- Records a security-relevant event, scoped to an organization and project
-- when it belongs to one. actor_label is the actor's name (or email) now, so
-- the row stays readable after the actor is purged.
INSERT INTO audit_events (
    user_id, actor_user_id, event, ip, user_agent, metadata,
    org_id, project_id, target_type, target_id, target_label, request_id, changes, actor_label
)
VALUES (
    sqlc.narg('user_id'), sqlc.narg('actor_user_id'), @event, sqlc.narg('ip'), @user_agent, @metadata,
    sqlc.narg('org_id'), sqlc.narg('project_id'), sqlc.narg('target_type'), sqlc.narg('target_id'),
    sqlc.narg('target_label'), sqlc.narg('request_id'), sqlc.narg('changes'),
    (SELECT COALESCE(NULLIF(u.name, ''), u.email::text) FROM users u WHERE u.id = sqlc.narg('actor_user_id'))
)
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
-- An organization's events, newest first, keyset-paginated like
-- ListAuditEventsForUser. Org-wide events (no project) are always included;
-- project events only for the projects in visible_projects (the ones the
-- caller can view). Optional filters: actor, exact event or event prefix
-- ('api_key.'), target type, a [from, to) time range, and text the target
-- label contains (case-insensitive). Served by audit_events_org_created.
SELECT * FROM audit_events
WHERE org_id = @org_id::uuid
  AND (project_id IS NULL OR project_id = ANY(@visible_projects::uuid[]))
  AND (sqlc.narg('actor_user_id')::uuid IS NULL OR actor_user_id = sqlc.narg('actor_user_id')::uuid)
  AND (sqlc.narg('event')::text IS NULL OR event = sqlc.narg('event')::text)
  AND (sqlc.narg('event_prefix')::text IS NULL OR starts_with(event, sqlc.narg('event_prefix')::text))
  AND (sqlc.narg('target_type')::text IS NULL OR target_type = sqlc.narg('target_type')::text)
  AND (sqlc.narg('target_label')::text IS NULL OR strpos(lower(target_label), lower(sqlc.narg('target_label')::text)) > 0)
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
  AND (sqlc.narg('event')::text IS NULL OR event = sqlc.narg('event')::text)
  AND (sqlc.narg('event_prefix')::text IS NULL OR starts_with(event, sqlc.narg('event_prefix')::text))
  AND (sqlc.narg('target_type')::text IS NULL OR target_type = sqlc.narg('target_type')::text)
  AND (sqlc.narg('target_label')::text IS NULL OR strpos(lower(target_label), lower(sqlc.narg('target_label')::text)) > 0)
  AND (sqlc.narg('from_time')::timestamptz IS NULL OR created_at >= sqlc.narg('from_time')::timestamptz)
  AND (sqlc.narg('to_time')::timestamptz IS NULL OR created_at < sqlc.narg('to_time')::timestamptz)
  AND (sqlc.narg('before_created_at')::timestamptz IS NULL
       OR (created_at, id) < (sqlc.narg('before_created_at')::timestamptz, sqlc.narg('before_id')::bigint))
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: DeleteAuditEventsBefore :execrows
-- Deletes up to batch_size events recorded before cutoff, oldest first (the
-- audit retention job, audit.retention). It walks the primary key: ids grow
-- with created_at, so the old rows are found at the start of the index and a
-- batch stops as soon as it has batch_size of them.
DELETE FROM audit_events
WHERE id IN (
    SELECT id FROM audit_events
    WHERE created_at < @cutoff::timestamptz
    ORDER BY id
    LIMIT @batch_size
);
