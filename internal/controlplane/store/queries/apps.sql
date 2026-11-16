-- Apps of a project as the ingest resolver and the Apps page see them.

-- name: ListResolverApps :many
-- Every app of the project the resolver must know about: active and
-- archived apps, and apps deleted after @deleted_since (their slugs stay
-- reserved).
SELECT id, slug, name, archived_at, deleted_at, merged_into, is_default
FROM apps
WHERE project_id = @project_id
  AND (deleted_at IS NULL OR deleted_at > @deleted_since)
ORDER BY slug, deleted_at DESC NULLS FIRST;

-- name: ListProjectAppAliases :many
SELECT alias_slug, app_id
FROM app_aliases
WHERE project_id = @project_id
ORDER BY alias_slug;

-- name: LockProjectByID :one
-- Row-locks an active project; serialises app creation per project.
SELECT id, slug, name, org_id
FROM projects
WHERE id = @id AND deleted_at IS NULL
FOR UPDATE;

-- name: CountActiveApps :one
SELECT count(*)::bigint FROM apps WHERE project_id = @project_id AND deleted_at IS NULL;

-- name: CountSDKAppsSince :one
-- Apps the SDK created in the project since @since, deleted ones included.
SELECT count(*)::bigint FROM apps
WHERE project_id = @project_id AND created_by = 'sdk' AND created_at >= @since;

-- name: GetRecentlyDeletedApp :one
SELECT id, slug, name, deleted_at
FROM apps
WHERE project_id = @project_id AND slug = @slug AND deleted_at > @deleted_since
ORDER BY deleted_at DESC
LIMIT 1;

-- name: InsertApp :one
-- Creates an app; a concurrent create of the same slug wins and this
-- returns no row.
INSERT INTO apps (id, project_id, slug, name, framework, created_by, created_by_key_id, first_seen_at, acknowledged_at, is_default)
VALUES (@id, @project_id, @slug, @name, '', @created_by, sqlc.narg(created_by_key_id), sqlc.narg(first_seen_at), sqlc.narg(acknowledged_at), @is_default)
ON CONFLICT (project_id, slug) WHERE deleted_at IS NULL DO NOTHING
RETURNING id, project_id, slug, name, created_by, created_at;

-- name: GetActiveAppBySlug :one
SELECT id, project_id, slug, name, archived_at, merged_into, is_default
FROM apps
WHERE project_id = @project_id AND slug = @slug AND deleted_at IS NULL;

-- name: GetDefaultApp :one
SELECT id, slug, name
FROM apps
WHERE project_id = @project_id AND is_default AND deleted_at IS NULL;

-- name: UnarchiveApp :one
-- Un-archives an archived app that was not merged into another.
UPDATE apps SET archived_at = NULL
WHERE id = @id AND archived_at IS NOT NULL AND merged_into IS NULL AND deleted_at IS NULL
RETURNING id, slug, name;

-- name: ListManagedApps :many
-- The Apps page: active, archived and recently deleted apps with their
-- origin.
SELECT a.id, a.slug, a.name, a.created_by, a.created_by_key_id, k.name AS created_by_key_name,
       a.created_at, a.first_seen_at, a.archived_at, a.deleted_at, a.acknowledged_at, a.is_default,
       a.merged_into, m.slug AS merged_into_slug
FROM apps a
LEFT JOIN api_keys k ON k.id = a.created_by_key_id
LEFT JOIN apps m ON m.id = a.merged_into
WHERE a.project_id = @project_id
  AND (a.deleted_at IS NULL OR a.deleted_at > @deleted_since)
ORDER BY a.deleted_at NULLS FIRST, a.archived_at NULLS FIRST, a.slug;

-- name: LockProjectApp :one
SELECT id, slug, name, archived_at, deleted_at, merged_into, is_default, acknowledged_at
FROM apps
WHERE project_id = @project_id AND id = @id
FOR UPDATE;

-- name: RenameApp :exec
UPDATE apps SET name = @name WHERE id = @id;

-- name: ArchiveApp :exec
UPDATE apps SET archived_at = COALESCE(archived_at, now()) WHERE id = @id;

-- name: RestoreApp :exec
-- Brings an archived, merged or deleted app back; acknowledges it.
UPDATE apps SET archived_at = NULL, deleted_at = NULL, merged_into = NULL,
    acknowledged_at = COALESCE(acknowledged_at, now())
WHERE id = @id;

-- name: DeleteApp :exec
UPDATE apps SET deleted_at = now() WHERE id = @id;

-- name: AcknowledgeApp :exec
UPDATE apps SET acknowledged_at = COALESCE(acknowledged_at, now()) WHERE id = @id;

-- name: MergeApp :exec
-- Archives the source app and records which app it was merged into.
UPDATE apps SET archived_at = COALESCE(archived_at, now()), merged_into = @target_id,
    acknowledged_at = COALESCE(acknowledged_at, now())
WHERE id = @source_id;

-- name: RepointMergedApps :exec
-- Apps merged into the source follow it to the target.
UPDATE apps SET merged_into = @target_id
WHERE merged_into = @source_id AND id <> @target_id;

-- name: RepointAppAliases :exec
UPDATE app_aliases SET app_id = @target_id WHERE app_id = @source_id;

-- name: UpsertAppAlias :exec
INSERT INTO app_aliases (project_id, alias_slug, app_id)
VALUES (@project_id, @alias_slug, @app_id)
ON CONFLICT (project_id, alias_slug) DO UPDATE SET app_id = EXCLUDED.app_id;

-- name: DeleteAppAlias :exec
DELETE FROM app_aliases WHERE project_id = @project_id AND alias_slug = @alias_slug;

-- name: DeleteAppAliasesTo :exec
DELETE FROM app_aliases WHERE app_id = @app_id;

-- name: UnmergeAppsFrom :exec
-- Apps merged into a deleted app stay archived but no longer point at it.
UPDATE apps SET merged_into = NULL WHERE merged_into = @app_id;

-- name: ListAppsLastSeen :many
-- When any key last sent records for each app of the project.
SELECT ka.app_id, CAST(max(ka.last_seen_at) AS timestamptz) AS last_seen_at
FROM api_key_apps ka
JOIN apps a ON a.id = ka.app_id
WHERE a.project_id = @project_id
GROUP BY ka.app_id;

-- name: SetAppDefault :exec
UPDATE apps SET is_default = true WHERE id = @id;
