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
SELECT m.user_id, m.role, m.invited_by, m.created_at, u.email, u.name, u.avatar_url, u.last_login_at
FROM memberships m
JOIN users u ON u.id = m.user_id
WHERE m.org_id = @org_id AND u.deleted_at IS NULL
ORDER BY m.created_at, u.email;

-- name: GetOrgMember :one
-- One member of an organization with their user; no row when the user is
-- not a member or their account is deleted.
SELECT m.user_id, m.role, m.invited_by, m.created_at, u.email, u.name, u.avatar_url, u.last_login_at
FROM memberships m
JOIN users u ON u.id = m.user_id
WHERE m.org_id = @org_id AND m.user_id = @user_id AND u.deleted_at IS NULL;

-- name: CountOrgOwners :one
-- Owners whose account is not deleted: a deleted owner cannot act for the
-- organization, so it does not count towards the last-owner rule.
SELECT count(*) FROM memberships m
JOIN users u ON u.id = m.user_id
WHERE m.org_id = @org_id AND m.role = 'owner' AND u.deleted_at IS NULL;

-- name: UpdateMembershipRole :one
UPDATE memberships SET role = @role
WHERE org_id = @org_id AND user_id = @user_id
RETURNING *;

-- name: DeleteMembership :execrows
DELETE FROM memberships
WHERE org_id = @org_id AND user_id = @user_id;
