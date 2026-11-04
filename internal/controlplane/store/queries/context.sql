-- Queries behind GET /api/v1/users/me/context: the signed-in user and every
-- organization and project they can see, read in a fixed number of round
-- trips whatever the number of organizations and projects.

-- name: GetContextUser :one
-- The active user. The control plane only reads the profile columns of
-- users (ADR 0005); identity owns every write.
SELECT * FROM users
WHERE id = @id AND deleted_at IS NULL;

-- name: ListUserProjects :many
-- The active projects of every active organization the user belongs to
-- (memberships_user, then projects_org), by organization then name.
SELECT p.id, p.org_id, p.slug, p.name
FROM memberships m
JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
JOIN projects p ON p.org_id = o.id AND p.deleted_at IS NULL
WHERE m.user_id = @user_id
ORDER BY p.org_id, p.name, p.slug;
