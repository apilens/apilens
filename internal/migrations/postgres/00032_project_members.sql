-- Project access (ADR 0009): direct project roles and each project's default
-- access for org members. Postgres holds the truth; the outbox feeds SpiceDB.
--
--   projects 1 ──< project_members.project_id   (cascade on hard delete)
--   users    1 ──< project_members.user_id      (cascade on purge)
--   users    1 ──< project_members.added_by     (SET NULL on purge)
--
-- A direct grant is one role per person and project (admin, editor, viewer);
-- the highest grant from any source wins, computed by authz, not here.
-- Grants go to org members only; the service layer enforces that and drops
-- a person's grants in an org when they leave it.
--
-- projects.default_access decides what org members get without a direct
-- grant: 'org_role' (org member edits, org viewer views; the behaviour every
-- existing project keeps), 'viewer' (everyone in the org views), 'none'
-- (only org owners/admins and people added directly).

-- +goose Up
CREATE TABLE IF NOT EXISTS project_members (
    project_id  uuid        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        text        NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    added_by    uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);
-- A user's grants; backs ON DELETE CASCADE from users.
CREATE INDEX IF NOT EXISTS project_members_user ON project_members (user_id);

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS default_access text NOT NULL DEFAULT 'org_role'
        CHECK (default_access IN ('org_role', 'viewer', 'none'));

-- +goose Down
ALTER TABLE projects DROP COLUMN IF EXISTS default_access;
DROP TABLE IF EXISTS project_members;
