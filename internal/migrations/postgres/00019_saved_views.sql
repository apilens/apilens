-- Saved views: named filter sets of a project's dashboard surfaces.
--
--   projects 1 ── * saved_views.project_id
--
-- surface is the dashboard surface the view belongs to; filter is the
-- surface's filter state as a JSON object, opaque to the server (the UI owns
-- its shape). A shared view is listed for everyone who can view the project;
-- a private one only for its creator. created_by is NULL once the creator's
-- user is gone (the view then stays, editable by project admins). Names are
-- unique per creator within a project and surface.

-- +goose Up
CREATE TABLE IF NOT EXISTS saved_views (
    id          uuid PRIMARY KEY,
    project_id  uuid        NOT NULL REFERENCES projects (id),
    name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    surface     text        NOT NULL CHECK (surface IN (
        'explore', 'endpoints', 'errors', 'performance', 'consumers', 'apps')),
    filter      jsonb       NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(filter) = 'object' AND octet_length(filter::text) <= 16384),
    shared      boolean     NOT NULL DEFAULT false,
    created_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_project_creator_name
    ON saved_views (project_id, surface, created_by, name);

-- +goose Down
DROP TABLE IF EXISTS saved_views;
