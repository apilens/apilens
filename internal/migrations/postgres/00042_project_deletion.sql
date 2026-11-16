-- Project deletion with a grace period (D8 in #753, #795).
--
-- Deleting a project sets deleted_at and purge_after = deleted_at +
-- project.deletion_grace (7 days by default). Until purge_after the project
-- can be restored; after it the purge job (#796) removes its data and moves
-- the slug to the 30-day reservation.
--
--   purge_after  when the purge job may remove the project; NULL for active
--                projects and for projects deleted before this migration
--                (they were deleted for good and keep freeing their slug).
--
-- A project scheduled for purge keeps its slug: projects_slug_reserved
-- makes the slug unique among active projects and projects awaiting purge,
-- so a restore never collides with a newer project. projects_slug_active
-- (active projects only) stays for the queries and constraints that name it.

-- +goose Up
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS purge_after timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_reserved
    ON projects (slug) WHERE deleted_at IS NULL OR purge_after IS NOT NULL;

-- The org's projects awaiting purge, newest deletion first.
CREATE INDEX IF NOT EXISTS projects_org_scheduled
    ON projects (org_id, deleted_at DESC) WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS projects_org_scheduled;
DROP INDEX IF EXISTS projects_slug_reserved;
ALTER TABLE projects DROP COLUMN IF EXISTS purge_after;
