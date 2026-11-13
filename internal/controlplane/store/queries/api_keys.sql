-- name: CreateAPIKey :one
-- Inserts a key and returns it with its creator.
WITH k AS (
    INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scopes, expires_at, app_ids, created_by, rate_limit_per_minute, environments)
    VALUES (@id, @project_id, @name, @prefix, @key_hash, @scopes, sqlc.narg(expires_at), sqlc.narg(app_ids)::uuid[], sqlc.narg(created_by)::uuid,
            sqlc.narg(rate_limit_per_minute)::integer, sqlc.narg(environments)::text[])
    RETURNING id, project_id, name, prefix, scopes, created_at, expires_at, app_ids, created_by, rate_limit_per_minute, environments
)
SELECT k.id, k.project_id, k.name, k.prefix, k.scopes, k.created_at, k.expires_at, k.app_ids, k.rate_limit_per_minute, k.environments,
       u.id AS creator_id, u.name AS creator_name, u.email AS creator_email
FROM k
LEFT JOIN users u ON u.id = k.created_by AND u.deleted_at IS NULL;

-- name: GetActiveAPIKeyByHash :one
-- Resolves an ingest key to its project. Revoked, expired and keys of
-- deleted projects never match.
SELECT k.id, k.project_id, k.scopes, k.expires_at, k.app_ids, k.rate_limit_per_minute, k.environments, p.slug AS project_slug, p.org_id
FROM api_keys k
JOIN projects p ON p.id = k.project_id
WHERE k.key_hash = @key_hash
  AND k.revoked_at IS NULL
  AND p.deleted_at IS NULL
  AND (k.expires_at IS NULL OR k.expires_at > now());

-- name: TouchAPIKey :exec
-- Records a use of the key. With record_use (an ingest request) the SDK and
-- client IP of that request replace the previous ones; NULL clears them.
UPDATE api_keys
SET last_used_at  = now(),
    last_used_sdk = CASE WHEN @record_use::bool THEN sqlc.narg(sdk)::text ELSE last_used_sdk END,
    last_used_ip  = CASE WHEN @record_use::bool THEN sqlc.narg(ip)::inet ELSE last_used_ip END
WHERE id = @id;

-- name: RevokeAPIKey :one
UPDATE api_keys SET revoked_at = now()
WHERE id = @id AND revoked_at IS NULL
RETURNING key_hash;

-- name: ListProjectAPIKeys :many
-- Every key of the project, revoked ones included, newest first, with its
-- creator (NULL when unknown or the account is deleted).
SELECT k.id, k.name, k.prefix, k.scopes, k.app_ids, k.environments, k.created_at, k.expires_at, k.revoked_at, k.last_used_at,
       k.last_used_sdk, k.last_used_ip, k.rate_limit_per_minute,
       u.id AS creator_id, u.name AS creator_name, u.email AS creator_email
FROM api_keys k
LEFT JOIN users u ON u.id = k.created_by AND u.deleted_at IS NULL
WHERE k.project_id = @project_id
ORDER BY k.created_at DESC, k.id;

-- name: LockProjectAPIKey :one
-- A key of the project, row-locked for the rest of the transaction, with
-- its creator (NULL when unknown or the account is deleted).
SELECT k.id, k.name, k.prefix, k.scopes, k.app_ids, k.environments, k.key_hash, k.revoked_at, k.created_at, k.expires_at, k.last_used_at,
       k.last_used_sdk, k.last_used_ip, k.rate_limit_per_minute,
       u.id AS creator_id, u.name AS creator_name, u.email AS creator_email
FROM api_keys k
LEFT JOIN users u ON u.id = k.created_by AND u.deleted_at IS NULL
WHERE k.id = @id AND k.project_id = @project_id
FOR UPDATE OF k;

-- name: UpdateAPIKeyAccess :exec
-- Replaces a key's scopes, app scope (NULL = every app), per-key ingest
-- rate limit (NULL = none) and environments (NULL = every environment).
UPDATE api_keys SET scopes = @scopes, app_ids = sqlc.narg(app_ids)::uuid[],
    rate_limit_per_minute = sqlc.narg(rate_limit_per_minute)::integer,
    environments = sqlc.narg(environments)::text[]
WHERE id = @id;

-- name: CountActiveProjectAPIKeys :one
-- The project's keys that still work: not revoked and not expired
-- (ingest.max_keys_per_project counts these).
SELECT count(*)::integer FROM api_keys
WHERE project_id = @project_id
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now());

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
