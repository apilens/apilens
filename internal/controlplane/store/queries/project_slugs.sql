-- Project slug renames (#794): retired slugs live in project_slug_history,
-- keep resolving to their project and are reserved for it for a while.

-- name: LockProjectSlug :exec
-- Serializes creates and renames that claim or retire the slug until the
-- transaction ends, so a reservation check and the write that relies on it
-- cannot interleave with another one.
SELECT pg_advisory_xact_lock(hashtextextended('project_slug:' || @slug::text, 0));

-- name: ProjectSlugReservedFor :one
-- Whether the slug is unusable for the project project_id: another active
-- project or one awaiting purge holds it, or a rename of another project
-- retired it after reserved_after.
SELECT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.slug = @slug::text AND (p.deleted_at IS NULL OR p.purge_after IS NOT NULL) AND p.id <> @project_id::uuid
    UNION ALL
    SELECT 1 FROM project_slug_history h
    WHERE h.slug = @slug::text AND h.project_id <> @project_id::uuid AND h.retired_at > @reserved_after::timestamptz
);

-- name: DeleteProjectSlugHistory :exec
-- Forgets a retired slug once a project uses it again.
DELETE FROM project_slug_history WHERE slug = @slug;

-- name: RetireProjectSlug :exec
-- Records that the project project_id no longer uses the slug.
INSERT INTO project_slug_history (slug, project_id, retired_at)
VALUES (@slug, @project_id, now())
ON CONFLICT (slug) DO UPDATE SET project_id = EXCLUDED.project_id, retired_at = EXCLUDED.retired_at;

-- name: SetProjectSlug :one
-- Renames the project and moves updated_at to now. Fails on
-- projects_slug_active or projects_slug_reserved when an active project or
-- one awaiting purge holds the slug.
UPDATE projects SET slug = @slug, updated_at = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING id, org_id, slug, name, description, created_at, updated_at, created_by, repository_url;
