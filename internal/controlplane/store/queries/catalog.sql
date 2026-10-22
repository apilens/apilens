-- name: UpsertOrganization :one
INSERT INTO organizations (id, slug, name)
VALUES (@id, @slug, @name)
ON CONFLICT (slug) WHERE deleted_at IS NULL
DO UPDATE SET name = organizations.name
RETURNING id, slug, name, created_at;

-- name: UpsertProject :one
INSERT INTO projects (id, org_id, slug, name)
VALUES (@id, @org_id, @slug, @name)
ON CONFLICT (slug) WHERE deleted_at IS NULL
DO UPDATE SET name = projects.name
RETURNING id, org_id, slug, name, created_at;

-- name: UpsertApp :one
INSERT INTO apps (id, project_id, slug, name, framework)
VALUES (@id, @project_id, @slug, @name, @framework)
ON CONFLICT (project_id, slug) WHERE deleted_at IS NULL
DO UPDATE SET name = apps.name
RETURNING id, project_id, slug, name, framework, created_at;

-- name: UpsertEnvironment :one
INSERT INTO environments (id, project_id, name)
VALUES (@id, @project_id, @name)
ON CONFLICT (project_id, name)
DO UPDATE SET name = environments.name
RETURNING id, project_id, name, created_at;

-- name: ListProjectApps :many
SELECT id, slug, name
FROM apps
WHERE project_id = @project_id AND deleted_at IS NULL
ORDER BY slug;

-- name: GetProjectWithOrg :one
SELECT p.id, p.slug, p.name, o.id AS org_id, o.slug AS org_slug, o.name AS org_name
FROM projects p
JOIN organizations o ON o.id = p.org_id
WHERE p.id = @id AND p.deleted_at IS NULL;
