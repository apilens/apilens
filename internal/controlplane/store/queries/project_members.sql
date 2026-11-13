-- Direct project roles and project default access (ADR 0009). Callers check
-- that the user is a member of the project's organization and emit the
-- outbox event in the same transaction.

-- name: UpsertProjectMember :one
-- Grants a role or changes it; added_by and created_at keep the first grant.
INSERT INTO project_members (project_id, user_id, role, added_by)
VALUES (@project_id, @user_id, @role, sqlc.narg(added_by))
ON CONFLICT (project_id, user_id) DO UPDATE
SET role = EXCLUDED.role, updated_at = now()
RETURNING *;

-- name: GetProjectMember :one
SELECT * FROM project_members
WHERE project_id = @project_id AND user_id = @user_id;

-- name: DeleteProjectMember :execrows
DELETE FROM project_members
WHERE project_id = @project_id AND user_id = @user_id;

-- name: ListProjectMembers :many
-- Direct grants of a project with their users; deleted accounts are hidden.
SELECT pm.user_id, pm.role, pm.added_by, pm.created_at, pm.updated_at,
       u.email, u.name, u.avatar_url, u.last_login_at
FROM project_members pm
JOIN users u ON u.id = pm.user_id
WHERE pm.project_id = @project_id AND u.deleted_at IS NULL
ORDER BY pm.created_at, u.email;

-- name: ListUserProjectMembers :many
-- A user's direct grants on active projects.
SELECT pm.project_id, pm.role, pm.added_by, pm.created_at, pm.updated_at,
       p.org_id, p.slug AS project_slug, p.name AS project_name
FROM project_members pm
JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
WHERE pm.user_id = @user_id
ORDER BY p.name, p.slug;

-- name: DeleteUserProjectMembersInOrg :many
-- Drops every direct grant a user holds on the organization's projects
-- (when they leave it); returns the project ids so the caller can emit one
-- outbox event per removed grant.
DELETE FROM project_members pm
USING projects p
WHERE pm.project_id = p.id AND p.org_id = @org_id AND pm.user_id = @user_id
RETURNING pm.project_id;

-- name: GetProjectDefaultAccess :one
SELECT default_access FROM projects
WHERE id = @id AND deleted_at IS NULL;

-- name: SetProjectDefaultAccess :one
UPDATE projects SET default_access = @default_access
WHERE id = @id AND deleted_at IS NULL
RETURNING default_access;
