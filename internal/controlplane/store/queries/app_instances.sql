-- name: UpsertAppInstance :exec
-- Records a heartbeat of one SDK process: the latest report replaces the
-- instance's previous one, first_seen_at is kept.
INSERT INTO app_instances (
    app_id, environment, instance_id, project_id, sdk_name, sdk_version,
    runtime, release, commit, pid, stats, first_seen_at, last_seen_at
)
VALUES (
    @app_id, @environment, @instance_id, @project_id, @sdk_name, @sdk_version,
    @runtime, @release, @commit, sqlc.narg(pid)::bigint, @stats, @seen_at, @seen_at
)
ON CONFLICT (app_id, environment, instance_id) DO UPDATE SET
    project_id   = EXCLUDED.project_id,
    sdk_name     = EXCLUDED.sdk_name,
    sdk_version  = EXCLUDED.sdk_version,
    runtime      = EXCLUDED.runtime,
    release      = EXCLUDED.release,
    commit       = EXCLUDED.commit,
    pid          = EXCLUDED.pid,
    stats        = EXCLUDED.stats,
    last_seen_at = GREATEST(app_instances.last_seen_at, EXCLUDED.last_seen_at);

-- name: GetProjectApp :one
-- An active app of a project; no row when the app is unknown, deleted or in
-- another project.
SELECT a.id, a.slug
FROM apps a
WHERE a.id = @id AND a.project_id = @project_id AND a.deleted_at IS NULL;

-- name: ListAppEnvironmentsLastSeen :many
-- The last heartbeat of an app per environment, and how many of its
-- instances were seen since @since.
SELECT environment, max(last_seen_at)::timestamptz AS last_seen_at,
       count(*) FILTER (WHERE last_seen_at >= @since)::int AS live_instances
FROM app_instances
WHERE app_id = @app_id
GROUP BY environment
ORDER BY environment;

-- name: ListRecentAppInstances :many
-- The most recently seen instances of an app.
SELECT environment, instance_id, sdk_name, sdk_version, runtime, release, commit, pid,
       stats, first_seen_at, last_seen_at
FROM app_instances
WHERE app_id = @app_id
ORDER BY last_seen_at DESC, environment, instance_id
LIMIT @max_rows;
