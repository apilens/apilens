-- App metadata the SDKs send once per process start (POST /v1/metadata):
-- framework and versions, the route templates the framework declares (so
-- endpoints with zero traffic can be listed) and the effective SDK config
-- (so the app settings page shows what an app actually runs with). One row
-- per app and environment; the latest report replaces the previous one.

-- +goose Up
CREATE TABLE IF NOT EXISTS app_metadata (
    app_id            uuid        NOT NULL REFERENCES apps (id),
    environment       text        NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
    project_id        uuid        NOT NULL REFERENCES projects (id),
    framework         text        NOT NULL DEFAULT '',
    framework_version text        NOT NULL DEFAULT '',
    runtime_version   text        NOT NULL DEFAULT '',
    sdk_version       text        NOT NULL DEFAULT '',
    routes            jsonb       NOT NULL DEFAULT '[]',
    config            jsonb       NOT NULL DEFAULT '{}',
    received_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, environment)
);
CREATE INDEX IF NOT EXISTS app_metadata_project ON app_metadata (project_id);

-- +goose Down
DROP TABLE IF EXISTS app_metadata;
