-- name: ListSavedViews :many
-- The views of a project that viewer may see: the shared ones, plus viewer's
-- own private ones (a NULL viewer, a read key, sees the shared ones only).
-- An empty surface lists every surface.
SELECT id, project_id, name, surface, filter, shared, created_by, created_at, updated_at
FROM saved_views
WHERE project_id = @project_id
  AND (shared OR created_by = sqlc.narg(viewer)::uuid)
  AND (@surface::text = '' OR surface = @surface::text)
ORDER BY surface, lower(name), created_at, id;

-- name: GetSavedView :one
SELECT id, project_id, name, surface, filter, shared, created_by, created_at, updated_at
FROM saved_views
WHERE id = @id AND project_id = @project_id;

-- name: CreateSavedView :one
INSERT INTO saved_views (id, project_id, name, surface, filter, shared, created_by)
VALUES (@id, @project_id, @name, @surface, @filter, @shared, @created_by)
RETURNING id, project_id, name, surface, filter, shared, created_by, created_at, updated_at;

-- name: UpdateSavedView :one
UPDATE saved_views
SET name = @name, filter = @filter, shared = @shared, updated_at = now()
WHERE id = @id AND project_id = @project_id
RETURNING id, project_id, name, surface, filter, shared, created_by, created_at, updated_at;

-- name: DeleteSavedView :execrows
DELETE FROM saved_views WHERE id = @id AND project_id = @project_id;
