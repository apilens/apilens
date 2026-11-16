-- Retired project slugs (#794, D9): a project slug can be renamed, and the
-- old one keeps naming the project the way GitHub redirects a renamed
-- repository.
--
--   slug        a slug a project used before a rename. One row per slug:
--               when the slug is retired again (by whichever project used
--               it later) the row is replaced.
--   project_id  the project the slug now leads to (projects 1 ──< history;
--               the rows go when the project is purged).
--   retired_at  when the rename happened.
--
-- Path resolution falls back to this table when no active project uses the
-- slug, so the old slug resolves until a project takes it again. For 30
-- days after retired_at only project_id itself may take the slug (a rename
-- back); creating or renaming another project to it answers slug_taken, and
-- slug-available reports it as taken. After that the slug is free again;
-- the row stays (and keeps resolving) until a project uses the slug, which
-- deletes it.

-- +goose Up
CREATE TABLE IF NOT EXISTS project_slug_history (
    slug       text        PRIMARY KEY CHECK (char_length(slug) BETWEEN 1 AND 63),
    project_id uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_slug_history_project ON project_slug_history (project_id);

-- +goose Down
DROP TABLE IF EXISTS project_slug_history;
