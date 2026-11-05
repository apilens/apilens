-- name: GetSettingsApp :one
-- An active app of an active project, with the project slug that authorizing
-- a settings change on it needs.
SELECT a.id, a.slug, a.project_id, p.slug AS project_slug
FROM apps a
JOIN projects p ON p.id = a.project_id
WHERE a.id = @id AND a.deleted_at IS NULL AND p.deleted_at IS NULL;

-- name: GetEndpointSettings :one
-- The settings row of one endpoint of an app; no row means the defaults.
SELECT app_id, method, path, expected_status_codes, latency_threshold_ms, excluded, updated_at, updated_by
FROM endpoint_settings
WHERE app_id = @app_id AND method = @method AND path = @path;

-- name: UpsertEndpointSettings :one
INSERT INTO endpoint_settings (app_id, method, path, expected_status_codes, latency_threshold_ms,
                               excluded, updated_at, updated_by)
VALUES (@app_id, @method, @path, @expected_status_codes::integer[], sqlc.narg(latency_threshold_ms)::integer,
        @excluded, now(), @updated_by)
ON CONFLICT (app_id, method, path)
DO UPDATE SET expected_status_codes = EXCLUDED.expected_status_codes,
              latency_threshold_ms  = EXCLUDED.latency_threshold_ms,
              excluded              = EXCLUDED.excluded,
              updated_at            = now(),
              updated_by            = EXCLUDED.updated_by
RETURNING app_id, method, path, expected_status_codes, latency_threshold_ms, excluded, updated_at, updated_by;

-- name: ListProjectEndpointSettings :many
-- The settings that change what the dashboard counts (an expected status
-- code or exclusion) for the active apps of a project.
SELECT es.app_id, es.method, es.path, es.expected_status_codes, es.excluded
FROM endpoint_settings es
JOIN apps a ON a.id = es.app_id
WHERE a.project_id = @project_id AND a.deleted_at IS NULL
  AND (es.excluded OR cardinality(es.expected_status_codes) > 0)
ORDER BY es.app_id, es.method, es.path;

-- name: GetAppSettings :one
-- The app-wide settings of an active app of a project; no row when the app
-- is unknown, deleted or in another project.
SELECT a.id, a.latency_threshold_ms
FROM apps a
WHERE a.id = @id AND a.project_id = @project_id AND a.deleted_at IS NULL;

-- name: UpdateAppLatencyThreshold :one
UPDATE apps
SET latency_threshold_ms = sqlc.narg(latency_threshold_ms)::integer
WHERE id = @id AND deleted_at IS NULL
RETURNING id, latency_threshold_ms;

-- name: ListProjectEndpointLatencyThresholds :many
-- The endpoints of a project's active apps with their own Apdex threshold.
SELECT es.app_id, es.method, es.path, es.latency_threshold_ms::integer AS latency_threshold_ms
FROM endpoint_settings es
JOIN apps a ON a.id = es.app_id
WHERE a.project_id = @project_id AND a.deleted_at IS NULL AND es.latency_threshold_ms IS NOT NULL
ORDER BY es.app_id, es.method, es.path;

-- name: ListProjectAppLatencyThresholds :many
-- The active apps of a project with an app-wide Apdex threshold.
SELECT a.id, a.latency_threshold_ms::integer AS latency_threshold_ms
FROM apps a
WHERE a.project_id = @project_id AND a.deleted_at IS NULL AND a.latency_threshold_ms IS NOT NULL
ORDER BY a.id;
