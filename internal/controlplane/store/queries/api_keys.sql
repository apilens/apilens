-- name: CreateAPIKey :one
INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scopes, expires_at, app_ids)
VALUES (@id, @project_id, @name, @prefix, @key_hash, @scopes, sqlc.narg(expires_at), sqlc.narg(app_ids)::uuid[])
RETURNING id, project_id, name, prefix, scopes, created_at, expires_at, app_ids;

-- name: GetActiveAPIKeyByHash :one
-- Resolves an ingest key to its project. Revoked, expired and keys of
-- deleted projects never match.
SELECT k.id, k.project_id, k.scopes, k.expires_at, k.app_ids, p.slug AS project_slug, p.org_id
FROM api_keys k
JOIN projects p ON p.id = k.project_id
WHERE k.key_hash = @key_hash
  AND k.revoked_at IS NULL
  AND p.deleted_at IS NULL
  AND (k.expires_at IS NULL OR k.expires_at > now());

-- name: TouchAPIKey :exec
UPDATE api_keys SET last_used_at = now() WHERE id = @id;

-- name: RevokeAPIKey :one
UPDATE api_keys SET revoked_at = now()
WHERE id = @id AND revoked_at IS NULL
RETURNING key_hash;

-- name: ListProjectAPIKeys :many
-- Every key of the project, revoked ones included, newest first.
SELECT id, name, prefix, scopes, app_ids, created_at, expires_at, revoked_at, last_used_at
FROM api_keys
WHERE project_id = @project_id
ORDER BY created_at DESC, id;

-- name: LockProjectAPIKey :one
-- A key of the project, row-locked for the rest of the transaction.
SELECT id, name, prefix, scopes, app_ids, key_hash, revoked_at, created_at, expires_at, last_used_at
FROM api_keys
WHERE id = @id AND project_id = @project_id
FOR UPDATE;

-- name: UpdateAPIKeyAccess :exec
-- Replaces a key's scopes and app scope (NULL = every app).
UPDATE api_keys SET scopes = @scopes, app_ids = sqlc.narg(app_ids)::uuid[]
WHERE id = @id;

-- name: ListProjectKeyApps :many
-- The apps each key of the project sent records for, with when.
SELECT ka.key_id, ka.app_id, a.slug AS app_slug, a.name AS app_name, ka.first_seen_at, ka.last_seen_at
FROM api_key_apps ka
JOIN api_keys k ON k.id = ka.key_id
JOIN apps a ON a.id = ka.app_id
WHERE k.project_id = @project_id
ORDER BY ka.last_seen_at DESC, a.slug;

-- name: UpsertAPIKeyApp :exec
-- Records that key_id sent records for app_id at seen_at.
INSERT INTO api_key_apps (key_id, app_id, first_seen_at, last_seen_at)
VALUES (@key_id, @app_id, @seen_at, @seen_at)
ON CONFLICT (key_id, app_id)
DO UPDATE SET last_seen_at = GREATEST(api_key_apps.last_seen_at, EXCLUDED.last_seen_at);

-- name: MarkAppFirstSeen :exec
UPDATE apps SET first_seen_at = @seen_at WHERE id = @id AND first_seen_at IS NULL;
