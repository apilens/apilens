-- name: CreateOrganization :one
-- The caller adds the creator's owner membership in the same transaction.
INSERT INTO organizations (id, slug, name, created_by)
VALUES (@id, @slug, @name, sqlc.narg(created_by))
RETURNING *;

-- name: OrganizationSlugTaken :one
SELECT EXISTS (
    SELECT 1 FROM organizations WHERE slug = @slug AND deleted_at IS NULL
);

-- name: GetOrganizationBySlug :one
SELECT * FROM organizations
WHERE slug = @slug AND deleted_at IS NULL;

-- name: LockOrganization :one
-- Row-locks an active organization for the rest of the transaction.
-- Membership writes that could remove the last owner take this lock first,
-- then check CountOrgOwners (the last-owner rule lives in the service layer).
SELECT id FROM organizations
WHERE id = @id AND deleted_at IS NULL
FOR UPDATE;

-- name: UpdateOrganization :one
-- NULL arguments leave the column unchanged. allowed_domains must be
-- lower-case (checked by the table).
UPDATE organizations
SET name            = coalesce(sqlc.narg(name), name),
    allowed_domains = coalesce(sqlc.narg(allowed_domains)::text[], allowed_domains),
    domain_join     = coalesce(sqlc.narg(domain_join), domain_join)
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: SoftDeleteOrganization :execrows
UPDATE organizations SET deleted_at = now()
WHERE id = @id AND deleted_at IS NULL;

-- name: ListUserOrganizations :many
-- The active organizations a user belongs to, with their role.
SELECT o.id, o.slug, o.name, o.created_at, m.role
FROM memberships m
JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = @user_id AND o.deleted_at IS NULL
ORDER BY o.name, o.slug;

-- name: ListJoinableOrganizations :many
-- Active organizations with domain join on for the (lower-case) email
-- domain that the user is not already a member of.
SELECT o.id, o.slug, o.name, o.created_at
FROM organizations o
WHERE o.domain_join
  AND o.deleted_at IS NULL
  AND o.allowed_domains @> ARRAY[@domain::text]
  AND NOT EXISTS (
      SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id = @user_id
  )
ORDER BY o.name, o.slug;
