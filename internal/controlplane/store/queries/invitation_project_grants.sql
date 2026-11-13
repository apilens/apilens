-- Project roles carried by invitations (#779). Only pending invitations have
-- grants: revoking or replacing an invitation deletes them.

-- name: CreateInvitationProjectGrant :exec
INSERT INTO invitation_project_grants (invitation_id, project_id, role)
VALUES (@invitation_id, @project_id, @role);

-- name: ListOrgActiveProjectsByID :many
-- The active projects of the organization among ids.
SELECT id, slug, name FROM projects
WHERE org_id = @org_id AND id = ANY(@ids::uuid[]) AND deleted_at IS NULL;

-- name: ListInvitationProjectGrants :many
-- The grants of the invitations with their active projects, by project
-- name; grants on deleted projects are left out.
SELECT g.invitation_id, g.project_id, g.role, p.slug AS project_slug, p.name AS project_name
FROM invitation_project_grants g
JOIN projects p ON p.id = g.project_id AND p.deleted_at IS NULL
WHERE g.invitation_id = ANY(@invitation_ids::uuid[])
ORDER BY g.invitation_id, p.name, p.slug;

-- name: DeleteInvitationProjectGrants :exec
DELETE FROM invitation_project_grants
WHERE invitation_id = @invitation_id;

-- name: DeletePendingInvitationProjectGrantsByEmail :exec
-- Drops the grants of the address's pending invitation to the organization
-- before RevokePendingInvitationByEmail replaces it.
DELETE FROM invitation_project_grants g
USING invitations i
WHERE g.invitation_id = i.id AND i.org_id = @org_id AND i.email = @email
  AND i.accepted_at IS NULL AND i.revoked_at IS NULL;

-- name: ListProjectPendingInvitations :many
-- The pending invitations that carry a grant on the project, newest first,
-- with the inviting user's email and name (NULL once their account is gone).
SELECT i.id, i.email, i.role, i.invited_by, i.created_at, i.expires_at, i.resent_at,
       u.email AS inviter_email, u.name AS inviter_name
FROM invitations i
JOIN invitation_project_grants g ON g.invitation_id = i.id AND g.project_id = @project_id
LEFT JOIN users u ON u.id = i.invited_by AND u.deleted_at IS NULL
WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
ORDER BY i.created_at DESC, i.email;
