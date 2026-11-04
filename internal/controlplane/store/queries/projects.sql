-- Explicit project and environment queries of the projects API. The
-- Upsert* queries in catalog.sql stay for the idempotent dev seed.

-- name: CreateProject :one
-- Fails on projects_slug_active when an active project uses the slug.
INSERT INTO projects (id, org_id, slug, name)
VALUES (@id, @org_id, @slug, @name)
RETURNING id, org_id, slug, name, created_at;

-- name: ProjectSlugTaken :one
SELECT EXISTS (
    SELECT 1 FROM projects WHERE slug = @slug AND deleted_at IS NULL
);

-- name: TakenProjectSlugs :many
-- Which of the given slugs active projects already use.
SELECT slug FROM projects
WHERE slug = ANY(@slugs::text[]) AND deleted_at IS NULL;

-- name: ListOrgProjects :many
SELECT id, org_id, slug, name, created_at
FROM projects
WHERE org_id = @org_id AND deleted_at IS NULL
ORDER BY name, slug;

-- name: GetMemberProject :one
-- An active project of an active organization by slug, with the user's role
-- in the organization; no row when either is missing or the user is not a
-- member.
SELECT p.id, p.slug, p.name, p.created_at, o.id AS org_id, o.slug AS org_slug, m.role
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
JOIN memberships m ON m.org_id = o.id AND m.user_id = @user_id
WHERE p.slug = @slug AND p.deleted_at IS NULL;

-- name: LockMemberProject :one
-- GetMemberProject, row-locking the project for the rest of the transaction.
SELECT p.id, p.slug, p.name, p.created_at, o.id AS org_id, o.slug AS org_slug, m.role
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
JOIN memberships m ON m.org_id = o.id AND m.user_id = @user_id
WHERE p.slug = @slug AND p.deleted_at IS NULL
FOR UPDATE OF p;

-- name: UpdateProjectName :one
UPDATE projects SET name = @name
WHERE id = @id AND deleted_at IS NULL
RETURNING id, org_id, slug, name, created_at;

-- name: SoftDeleteProject :execrows
UPDATE projects SET deleted_at = now()
WHERE id = @id AND deleted_at IS NULL;

-- name: CreateEnvironment :execrows
-- Adds the environment unless the project already has one of that name.
INSERT INTO environments (id, project_id, name)
VALUES (@id, @project_id, @name)
ON CONFLICT (project_id, name) DO NOTHING;

-- name: DeleteEnvironment :execrows
DELETE FROM environments
WHERE project_id = @project_id AND name = @name;

-- name: ListProjectsEnvironments :many
-- The environments of the given projects, by project then name.
SELECT project_id, name
FROM environments
WHERE project_id = ANY(@project_ids::uuid[])
ORDER BY project_id, name;
