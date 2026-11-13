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

-- name: ListProjectAccess :many
-- Every org member who can view the project (ADR 0009), with what each
-- source grants as a rank (0 none, 1 viewer, 2 editor, 3 admin): the org
-- role (owners and admins are admin), the project default access and a
-- direct grant. The effective rank is the highest. Filters: q (substring of
-- name or email; the caller escapes LIKE wildcards), effective_rank, source
-- (org_role, default, direct). Keyset pagination on (email, user_id).
WITH ranked AS (
    SELECT m.user_id, m.role AS org_role, m.created_at AS joined_at,
           u.email, u.name, u.last_login_at,
           pm.role AS direct_role, pm.added_by, pm.created_at AS granted_at,
           (CASE WHEN m.role IN ('owner', 'admin') THEN 3 ELSE 0 END)::int AS org_rank,
           (CASE
                WHEN p.default_access = 'org_role' AND m.role = 'member' THEN 2
                WHEN p.default_access = 'org_role' AND m.role = 'viewer' THEN 1
                WHEN p.default_access = 'viewer' AND m.role IN ('member', 'viewer') THEN 1
                ELSE 0
            END)::int AS default_rank,
           (CASE pm.role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)::int AS direct_rank
    FROM projects p
    JOIN memberships m ON m.org_id = p.org_id
    JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = m.user_id
    WHERE p.id = @project_id AND p.deleted_at IS NULL
)
SELECT r.user_id, r.org_role, r.joined_at, r.email, r.name, r.last_login_at,
       r.direct_role, r.added_by, r.granted_at, r.org_rank, r.default_rank, r.direct_rank,
       GREATEST(r.org_rank, r.default_rank, r.direct_rank)::int AS effective_rank,
       ab.name AS added_by_name, ab.email AS added_by_email
FROM ranked r
LEFT JOIN users ab ON ab.id = r.added_by AND ab.deleted_at IS NULL
WHERE GREATEST(r.org_rank, r.default_rank, r.direct_rank) > 0
  AND (sqlc.narg(q)::text IS NULL OR r.email::text ILIKE '%' || sqlc.narg(q)::text || '%' OR r.name ILIKE '%' || sqlc.narg(q)::text || '%')
  AND (sqlc.narg(effective_rank)::int IS NULL OR GREATEST(r.org_rank, r.default_rank, r.direct_rank) = sqlc.narg(effective_rank)::int)
  AND (sqlc.narg(source)::text IS NULL
       OR (sqlc.narg(source)::text = 'org_role' AND r.org_rank > 0)
       OR (sqlc.narg(source)::text = 'default' AND r.default_rank > 0)
       OR (sqlc.narg(source)::text = 'direct' AND r.direct_rank > 0))
  AND (sqlc.narg(after_email)::text IS NULL
       OR (r.email, r.user_id) > (sqlc.narg(after_email)::citext, sqlc.narg(after_id)::uuid))
ORDER BY r.email, r.user_id
LIMIT @row_limit;
