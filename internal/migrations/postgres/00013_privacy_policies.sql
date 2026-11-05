-- Server-side privacy policy: the deny list the ingest edge applies to every
-- record before it is stored (the second line of defence behind the SDKs'
-- own masking). One row per project (app_id NULL) and at most one per app;
-- the edge applies the built-in defaults, the project row and the record's
-- app row together. Each list holds case-insensitive RE2 patterns matched
-- against the NAME of a query parameter, header or JSON body field; matching
-- values are replaced with "[redacted]".

-- +goose Up
CREATE TABLE IF NOT EXISTS privacy_policies (
    id                uuid PRIMARY KEY,
    project_id        uuid        NOT NULL REFERENCES projects (id),
    app_id            uuid        REFERENCES apps (id),
    mask_query_params text[]      NOT NULL DEFAULT '{}',
    mask_headers      text[]      NOT NULL DEFAULT '{}',
    mask_body_fields  text[]      NOT NULL DEFAULT '{}',
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT privacy_policies_scope UNIQUE NULLS NOT DISTINCT (project_id, app_id)
);

-- +goose Down
DROP TABLE IF EXISTS privacy_policies;
