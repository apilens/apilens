-- Membership writes never check the last-owner rule themselves: the service
-- layer locks the organization (LockOrganization), checks CountOrgOwners and
-- only then demotes or removes an owner, in one transaction.

-- name: CreateMembership :one
INSERT INTO memberships (org_id, user_id, role, invited_by)
VALUES (@org_id, @user_id, @role, sqlc.narg(invited_by))
RETURNING *;

-- name: GetMembership :one
SELECT * FROM memberships
WHERE org_id = @org_id AND user_id = @user_id;

-- name: ListOrgMembers :many
SELECT m.user_id, m.role, m.invited_by, m.created_at, u.email, u.name, u.avatar_url
FROM memberships m
JOIN users u ON u.id = m.user_id
WHERE m.org_id = @org_id AND u.deleted_at IS NULL
ORDER BY m.created_at, u.email;

-- name: CountOrgOwners :one
SELECT count(*) FROM memberships
WHERE org_id = @org_id AND role = 'owner';

-- name: UpdateMembershipRole :one
UPDATE memberships SET role = @role
WHERE org_id = @org_id AND user_id = @user_id
RETURNING *;

-- name: DeleteMembership :execrows
DELETE FROM memberships
WHERE org_id = @org_id AND user_id = @user_id;
