-- Invitations that carry project roles (#779, D4 in #753): inviting someone
-- who is not yet an org member to a project creates an org invitation with
-- one or more project grants, applied when the invitation is accepted.
--
--   invitations 1 ──< invitation_project_grants.invitation_id  (cascade)
--   projects    1 ──< invitation_project_grants.project_id     (cascade on hard delete)
--
-- One role per (invitation, project). Accepting the invitation creates the
-- membership and a project_members row for each grant whose project is still
-- active, in one transaction, with their outbox rows. Revoking the
-- invitation (or replacing it with a new one) deletes its grants, so only a
-- pending invitation has any. The inviter's manage_access on each project is
-- checked by the service layer when the invitation is created.

-- +goose Up
CREATE TABLE IF NOT EXISTS invitation_project_grants (
    invitation_id uuid NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
    project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    role          text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    PRIMARY KEY (invitation_id, project_id)
);
-- A project's pending invitations (GET /projects/{slug}/invitations); backs
-- ON DELETE CASCADE from projects.
CREATE INDEX IF NOT EXISTS invitation_project_grants_project ON invitation_project_grants (project_id);

-- +goose Down
DROP TABLE IF EXISTS invitation_project_grants;
