-- Explicit project and environment queries of the projects API. The
-- Upsert* queries in catalog.sql stay for the idempotent dev seed.

-- name: CreateProject :one
-- Fails on projects_slug_active or projects_slug_reserved when an active
-- project or one awaiting purge holds the slug.
INSERT INTO projects (id, org_id, slug, name, description, created_by)
VALUES (@id, @org_id, @slug, @name, @description, @created_by)
RETURNING id, org_id, slug, name, description, created_at, updated_at, created_by, repository_url;

-- name: ProjectSlugTaken :one
-- Whether an active project or one awaiting purge holds the slug, or a
-- rename retired it after reserved_after (project_slug_history keeps it for
-- its project).
SELECT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.slug = @slug::text AND (p.deleted_at IS NULL OR p.purge_after IS NOT NULL)
    UNION ALL
    SELECT 1 FROM project_slug_history h
    WHERE h.slug = @slug::text AND h.retired_at > @reserved_after::timestamptz
);

-- name: TakenProjectSlugs :many
-- Which of the given slugs active projects or projects awaiting purge hold,
-- or a rename retired after reserved_after.
SELECT p.slug FROM projects p
WHERE p.slug = ANY(@slugs::text[]) AND (p.deleted_at IS NULL OR p.purge_after IS NOT NULL)
UNION
SELECT h.slug FROM project_slug_history h
WHERE h.slug = ANY(@slugs::text[]) AND h.retired_at > @reserved_after::timestamptz;

-- name: ListOrgProjects :many
SELECT id, org_id, slug, name, description, created_at, updated_at, created_by, repository_url
FROM projects
WHERE org_id = @org_id AND deleted_at IS NULL
ORDER BY name, slug;

-- name: GetMemberProject :one
-- An active project of an active organization by slug, with the user's role
-- in the organization; no row when either is missing or the user is not a
-- member.
SELECT p.id, p.slug, p.name, p.description, p.created_at, p.updated_at, p.created_by, o.id AS org_id, o.slug AS org_slug, m.role
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
JOIN memberships m ON m.org_id = o.id AND m.user_id = @user_id
WHERE p.slug = @slug AND p.deleted_at IS NULL;

-- name: LockMemberProject :one
-- GetMemberProject, row-locking the project for the rest of the transaction.
SELECT p.id, p.slug, p.name, p.description, p.created_at, p.updated_at, p.created_by, o.id AS org_id, o.slug AS org_slug, m.role
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
JOIN memberships m ON m.org_id = o.id AND m.user_id = @user_id
WHERE p.slug = @slug AND p.deleted_at IS NULL
FOR UPDATE OF p;

-- name: GetActiveProject :one
-- An active project of an active organization by id; no row when either is
-- missing. Callers have authorized the user on it (authz guard).
SELECT p.id, p.slug, p.name, p.description, p.created_at, p.updated_at, p.created_by, p.repository_url, o.id AS org_id, o.slug AS org_slug
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
WHERE p.id = @id AND p.deleted_at IS NULL;

-- name: LockActiveProject :one
-- GetActiveProject, row-locking the project for the rest of the transaction.
SELECT p.id, p.slug, p.name, p.description, p.created_at, p.updated_at, p.created_by, p.repository_url, o.id AS org_id, o.slug AS org_slug
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
WHERE p.id = @id AND p.deleted_at IS NULL
FOR UPDATE OF p;

-- name: UpdateProjectDetails :one
-- Sets the name, description and repository link and moves updated_at to now.
UPDATE projects SET name = @name, description = @description, repository_url = @repository_url, updated_at = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING id, org_id, slug, name, description, created_at, updated_at, created_by, repository_url;

-- name: ScheduleProjectDeletion :one
-- Soft-deletes the project and schedules its purge grace_seconds from now
-- (0: at once). The slug stays reserved until the purge (projects_slug_reserved).
UPDATE projects
SET deleted_at = now(), purge_after = now() + make_interval(secs => @grace_seconds::bigint)
WHERE id = @id AND deleted_at IS NULL
RETURNING deleted_at::timestamptz AS deleted_at, purge_after::timestamptz AS purge_after;

-- name: ListScheduledProjects :many
-- The organization's deleted projects that can still be restored (purge
-- not yet due), most recently deleted first.
SELECT id, slug, name, description, created_at, deleted_at::timestamptz AS deleted_at, purge_after::timestamptz AS purge_after
FROM projects
WHERE org_id = @org_id AND deleted_at IS NOT NULL AND purge_after > now()
ORDER BY deleted_at DESC, id;

-- name: LockScheduledProject :one
-- A deleted project of the active organization org_id that can still be
-- restored, row-locked for the rest of the transaction.
SELECT p.id, p.slug, p.name, p.description, p.default_access, p.created_at, p.updated_at, p.created_by, p.repository_url,
       o.id AS org_id, o.slug AS org_slug, p.purge_after::timestamptz AS purge_after
FROM projects p
JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL
WHERE p.id = @id AND o.id = @org_id AND p.deleted_at IS NOT NULL AND p.purge_after > now()
FOR UPDATE OF p;

-- name: RestoreProject :execrows
UPDATE projects SET deleted_at = NULL, purge_after = NULL
WHERE id = @id AND deleted_at IS NOT NULL;

-- name: ListProjectMemberRoles :many
-- The direct grants of a project, to rebuild its relationships on restore.
SELECT user_id, role FROM project_members
WHERE project_id = @project_id
ORDER BY user_id;

-- name: CreateEnvironment :execrows
-- Adds the environment unless the project already has one of that name. It
-- goes last in the project's order; production and prod are marked as
-- production.
INSERT INTO environments (id, project_id, name, is_production, position, source)
VALUES (
    @id, @project_id, @name, @name::text IN ('production', 'prod'),
    (SELECT COALESCE(max(position) + 1, 0) FROM environments WHERE project_id = @project_id),
    'dashboard'
)
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

-- name: ListProjectEnvironmentDetails :many
-- The environments of one project in display order, with the active API
-- keys pinned to each and the health checks that use each.
SELECT e.name, e.is_production, e.color, e.position, e.hidden_at, e.source,
       e.first_seen_at, e.last_seen_at, e.created_at,
       (SELECT count(*) FROM api_keys k
        WHERE k.project_id = e.project_id AND e.name = ANY(k.environments)
          AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))::int AS api_keys,
       (SELECT count(*) FROM health_checks h
        WHERE h.project_id = e.project_id AND h.environment = e.name)::int AS health_checks
FROM environments e
WHERE e.project_id = @project_id
ORDER BY e.position, e.name;

-- name: UpdateEnvironmentSettings :execrows
UPDATE environments
SET is_production = @is_production, color = sqlc.narg(color), hidden_at = sqlc.narg(hidden_at)
WHERE project_id = @project_id AND name = @name;

-- name: SetEnvironmentPositions :exec
-- Gives each named environment its index in names as its position.
UPDATE environments e
SET position = o.ord - 1
FROM unnest(@names::text[]) WITH ORDINALITY AS o(name, ord)
WHERE e.project_id = @project_id AND e.name = o.name;
