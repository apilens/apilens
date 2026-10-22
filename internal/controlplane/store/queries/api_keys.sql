-- name: CreateAPIKey :one
INSERT INTO api_keys (id, project_id, name, prefix, key_hash, scopes, expires_at)
VALUES (@id, @project_id, @name, @prefix, @key_hash, @scopes, sqlc.narg(expires_at))
RETURNING id, project_id, name, prefix, scopes, created_at, expires_at;

-- name: GetActiveAPIKeyByHash :one
-- Resolves an ingest key to its project. Revoked, expired and keys of
-- deleted projects never match.
SELECT k.id, k.project_id, k.scopes, k.expires_at, p.slug AS project_slug, p.org_id
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
