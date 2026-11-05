-- name: UpsertAppMetadata :exec
-- Stores the latest metadata report of an app in an environment and, in the
-- same statement, records the reported framework on the app when it has
-- none yet.
WITH app_framework AS (
    UPDATE apps
    SET framework = @framework::text
    WHERE id = @app_id AND framework = '' AND @framework::text <> ''
)
INSERT INTO app_metadata (
    app_id, environment, project_id, framework, framework_version,
    runtime_version, sdk_version, routes, config, received_at
)
VALUES (
    @app_id, @environment, @project_id, @framework::text, @framework_version,
    @runtime_version, @sdk_version, @routes, @config, @received_at
)
ON CONFLICT (app_id, environment) DO UPDATE SET
    project_id        = EXCLUDED.project_id,
    framework         = EXCLUDED.framework,
    framework_version = EXCLUDED.framework_version,
    runtime_version   = EXCLUDED.runtime_version,
    sdk_version       = EXCLUDED.sdk_version,
    routes            = EXCLUDED.routes,
    config            = EXCLUDED.config,
    received_at       = EXCLUDED.received_at;
