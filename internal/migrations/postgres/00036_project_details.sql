-- Project details for the General settings section (#786): a short
-- description, when the project last changed and who created it.
--
--   description  free text shown under the project name, at most 280
--                characters; '' when the project has none.
--   updated_at   set by the application whenever the name or description
--                changes; existing projects start at their created_at.
--   created_by   the user who created the project; NULL for projects made
--                before this column, by the seed, or once the user is purged
--                (users 1 ──< projects.created_by, SET NULL on purge).
--
-- The id was always there; the API now returns it as the immutable project
-- identifier next to the (renameable) slug.

-- +goose Up
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT ''
        CHECK (char_length(description) <= 280),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz,
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users (id) ON DELETE SET NULL;
UPDATE projects SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE projects
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET NOT NULL;

-- +goose Down
ALTER TABLE projects
    DROP COLUMN IF EXISTS created_by,
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS description;
