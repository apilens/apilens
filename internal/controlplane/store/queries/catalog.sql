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
-- Registers an app (seed, tests); never changes an existing one.
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

-- name: ListPickerEnvironments :many
-- The environments of one project in display order and whether each is
-- hidden, for the environment pickers.
SELECT name, (hidden_at IS NOT NULL)::bool AS hidden
FROM environments
WHERE project_id = @project_id
ORDER BY position, name;

-- name: GetProjectWithOrg :one
SELECT p.id, p.slug, p.name, o.id AS org_id, o.slug AS org_slug, o.name AS org_name
FROM projects p
JOIN organizations o ON o.id = p.org_id
WHERE p.id = @id AND p.deleted_at IS NULL;

-- name: ResolveProjectSlug :one
-- Resolves a project slug (globally unique among active projects) to its
-- id, its active organization and its current (canonical) slug, for
-- authorization of /…/{project} paths. A slug no active project uses falls
-- back to project_slug_history: a renamed project's old slug resolves to it
-- until another project takes the slug.
SELECT r.id, r.org_id, r.slug
FROM (
    SELECT p.id, p.org_id, p.slug, 0 AS rank
    FROM projects p
    JOIN organizations o ON o.id = p.org_id
    WHERE p.slug = @slug AND p.deleted_at IS NULL AND o.deleted_at IS NULL
    UNION ALL
    SELECT p.id, p.org_id, p.slug, 1 AS rank
    FROM project_slug_history h
    JOIN projects p ON p.id = h.project_id
    JOIN organizations o ON o.id = p.org_id
    WHERE h.slug = @slug AND p.deleted_at IS NULL AND o.deleted_at IS NULL
) r
ORDER BY r.rank
LIMIT 1;
