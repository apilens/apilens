-- Environments ingest registers from the names SDKs send (#788). Ingest
-- writes here off the request path, at most once a minute per project and
-- environment and process (catalog.EnvironmentRegistry).

-- name: ListProjectEnvironmentNames :many
SELECT name FROM environments WHERE project_id = @project_id;

-- name: CountProjectEnvironments :one
SELECT count(*)::bigint FROM environments WHERE project_id = @project_id;

-- name: CountSDKEnvironmentsSince :one
-- Environments ingest registered in the project since @since.
SELECT count(*)::bigint FROM environments
WHERE project_id = @project_id AND source = 'sdk' AND created_at >= @since;

-- name: RegisterSDKEnvironment :execrows
-- Adds an environment the SDK reported unless the project already has one
-- of that name. It goes last in the project's order; production and prod are
-- marked as production.
INSERT INTO environments (id, project_id, name, is_production, position, source, first_seen_at, last_seen_at)
VALUES (
    @id, @project_id, @name, @name::text IN ('production', 'prod'),
    (SELECT COALESCE(max(position) + 1, 0) FROM environments WHERE project_id = @project_id),
    'sdk', @seen_at, @seen_at
)
ON CONFLICT (project_id, name) DO NOTHING;

-- name: TouchEnvironmentSeen :execrows
-- Moves last_seen_at forward (and sets first_seen_at the first time) when
-- data names the environment.
UPDATE environments
SET first_seen_at = COALESCE(first_seen_at, @seen_at),
    last_seen_at  = GREATEST(COALESCE(last_seen_at, @seen_at), @seen_at)
WHERE project_id = @project_id AND name = @name;
