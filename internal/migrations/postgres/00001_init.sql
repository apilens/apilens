-- Control-plane schema, v2 baseline.
-- Identity (users, memberships, credentials) arrives in M2 as its own
-- migration owned by the identity module.

-- +goose Up
CREATE TABLE IF NOT EXISTS organizations (
    id          uuid PRIMARY KEY,
    slug        text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_active
    ON organizations (slug) WHERE deleted_at IS NULL;

-- Project slugs are globally unique among active projects (legacy behaviour
-- the SDK's project_slug check relies on).
CREATE TABLE IF NOT EXISTS projects (
    id          uuid PRIMARY KEY,
    org_id      uuid        NOT NULL REFERENCES organizations (id),
    slug        text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name        text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_active
    ON projects (slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_org ON projects (org_id);

CREATE TABLE IF NOT EXISTS apps (
    id          uuid PRIMARY KEY,
    project_id  uuid        NOT NULL REFERENCES projects (id),
    slug        text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name        text        NOT NULL,
    framework   text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS apps_project_slug_active
    ON apps (project_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS environments (
    id          uuid PRIMARY KEY,
    project_id  uuid        NOT NULL REFERENCES projects (id),
    name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- Project-scoped ingest keys. Only the SHA-256 of the full key is stored;
-- prefix (first 16 chars) is kept for display. Legacy "apilens_" keys hash
-- the same way, so migrated keys keep working.
CREATE TABLE IF NOT EXISTS api_keys (
    id            uuid PRIMARY KEY,
    project_id    uuid        NOT NULL REFERENCES projects (id),
    name          text        NOT NULL,
    prefix        text        NOT NULL,
    key_hash      text        NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    scopes        text[]      NOT NULL DEFAULT ARRAY['ingest'],
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz,
    revoked_at    timestamptz,
    last_used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_project ON api_keys (project_id);

-- Transactional outbox: rows are written in the same transaction as the
-- change they describe and relayed in id order (to SpiceDB in M2).
CREATE TABLE IF NOT EXISTS outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    topic           text        NOT NULL,
    aggregate_id    text        NOT NULL,
    payload         jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (id) WHERE processed_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS environments;
DROP TABLE IF EXISTS apps;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS organizations;
