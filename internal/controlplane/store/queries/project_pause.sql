-- Pausing and resuming ingest for a project (#792). The ingest edge reads
-- projects.paused_at with the API key (GetActiveAPIKeyByHash).

-- name: PauseProject :execrows
-- Pauses ingest for the active project; no row changes when it is already
-- paused.
UPDATE projects SET paused_at = now(), paused_by = sqlc.narg(paused_by)::uuid
WHERE id = @id AND deleted_at IS NULL AND paused_at IS NULL;

-- name: ResumeProject :execrows
-- Resumes ingest for the active project; no row changes when it is not
-- paused.
UPDATE projects SET paused_at = NULL, paused_by = NULL
WHERE id = @id AND deleted_at IS NULL AND paused_at IS NOT NULL;

-- name: ListPausedProjects :many
-- Which of the given projects are paused, since when and by whom.
SELECT id, paused_at::timestamptz AS paused_at, paused_by
FROM projects
WHERE id = ANY(@ids::uuid[]) AND paused_at IS NOT NULL;

-- name: ListProjectKeyHashes :many
-- The hashes of the project's keys that are not revoked, so a pause,
-- resume, delete or restore can drop them from every verifier cache.
SELECT key_hash FROM api_keys
WHERE project_id = @project_id AND revoked_at IS NULL;
