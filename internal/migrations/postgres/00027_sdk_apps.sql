-- Apps come from the SDK. A project is the product, an app is one service in
-- it, and the app name an SDK sends decides the app: ingest creates an app it
-- has not seen in the key's project instead of rejecting the batch.
--
--   projects 1 ──< apps.project_id
--   api_keys 1 ──< apps.created_by_key_id     (the key whose data created it)
--   apps     1 ──< apps.merged_into           (an app merged into another)
--   apps     1 ──< app_aliases.app_id         (old slugs routed to the app)
--   api_keys 1 ──< api_key_apps.key_id        (which apps a key sends for)
--   apps     1 ──< api_key_apps.app_id
--
-- api_keys.scopes gains 'apps:create' (may auto-create apps). Every existing
-- ingest key gets it, so keys keep behaving like the SDK-first default.
-- api_keys.app_ids optionally limits a key to some apps (NULL = all apps);
-- a scoped key never creates apps.

-- +goose Up
ALTER TABLE apps
    ADD COLUMN IF NOT EXISTS created_by        text NOT NULL DEFAULT 'dashboard'
        CHECK (created_by IN ('sdk', 'dashboard')),
    ADD COLUMN IF NOT EXISTS created_by_key_id uuid REFERENCES api_keys (id),
    ADD COLUMN IF NOT EXISTS first_seen_at     timestamptz,
    ADD COLUMN IF NOT EXISTS archived_at       timestamptz,
    ADD COLUMN IF NOT EXISTS acknowledged_at   timestamptz,
    ADD COLUMN IF NOT EXISTS merged_into       uuid REFERENCES apps (id),
    ADD COLUMN IF NOT EXISTS is_default        boolean NOT NULL DEFAULT false;

-- Apps that existed before this migration were all registered by the
-- control plane; nobody needs to be told about them.
UPDATE apps SET acknowledged_at = created_at WHERE acknowledged_at IS NULL;

-- The default app of a project receives records that name no app. It is the
-- app created with the project (slug = project slug), else the oldest app.
UPDATE apps a SET is_default = true
FROM (
    SELECT DISTINCT ON (a2.project_id) a2.id
    FROM apps a2
    JOIN projects p ON p.id = a2.project_id
    WHERE a2.deleted_at IS NULL
    ORDER BY a2.project_id, (a2.slug = p.slug) DESC, a2.created_at, a2.id
) d
WHERE a.id = d.id;

CREATE UNIQUE INDEX IF NOT EXISTS apps_project_default
    ON apps (project_id) WHERE is_default AND deleted_at IS NULL;
-- Recently deleted slugs stay reserved; the resolver lists them.
CREATE INDEX IF NOT EXISTS apps_project_deleted
    ON apps (project_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Slugs of apps merged into another app. Records naming an alias land in
-- app_id. An alias is unique per project.
CREATE TABLE IF NOT EXISTS app_aliases (
    project_id  uuid        NOT NULL REFERENCES projects (id),
    alias_slug  text        NOT NULL CHECK (alias_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    app_id      uuid        NOT NULL REFERENCES apps (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, alias_slug)
);
CREATE INDEX IF NOT EXISTS app_aliases_app ON app_aliases (app_id);

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS app_ids uuid[];
ALTER TABLE api_keys ALTER COLUMN scopes SET DEFAULT ARRAY['ingest', 'apps:create'];
UPDATE api_keys SET scopes = scopes || ARRAY['apps:create']
WHERE 'ingest' = ANY (scopes) AND NOT ('apps:create' = ANY (scopes));

-- Which apps each key sends records for. Ingest upserts at most once per
-- key and app per minute per process.
CREATE TABLE IF NOT EXISTS api_key_apps (
    key_id         uuid        NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
    app_id         uuid        NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (key_id, app_id)
);
CREATE INDEX IF NOT EXISTS api_key_apps_app ON api_key_apps (app_id);

-- +goose Down
DROP TABLE IF EXISTS api_key_apps;
UPDATE api_keys SET scopes = array_remove(scopes, 'apps:create');
ALTER TABLE api_keys ALTER COLUMN scopes SET DEFAULT ARRAY['ingest'];
ALTER TABLE api_keys DROP COLUMN IF EXISTS app_ids;
DROP TABLE IF EXISTS app_aliases;
DROP INDEX IF EXISTS apps_project_deleted;
DROP INDEX IF EXISTS apps_project_default;
ALTER TABLE apps
    DROP COLUMN IF EXISTS is_default,
    DROP COLUMN IF EXISTS merged_into,
    DROP COLUMN IF EXISTS acknowledged_at,
    DROP COLUMN IF EXISTS archived_at,
    DROP COLUMN IF EXISTS first_seen_at,
    DROP COLUMN IF EXISTS created_by_key_id,
    DROP COLUMN IF EXISTS created_by;
