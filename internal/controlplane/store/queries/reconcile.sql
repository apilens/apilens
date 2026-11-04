-- The authz reconciler (ADR 0006) compares these with SpiceDB. They describe
-- the relationships the outbox relay leaves behind once it has applied every
-- row: one org role per membership of an active organization, and one
-- project#org per active project of an active organization.

-- name: ListReconcileMemberships :many
SELECT m.org_id, m.user_id, m.role
FROM memberships m
JOIN organizations o ON o.id = m.org_id
WHERE o.deleted_at IS NULL
ORDER BY m.org_id, m.user_id;

-- name: ListReconcileProjects :many
SELECT p.id, p.org_id
FROM projects p
JOIN organizations o ON o.id = p.org_id
WHERE p.deleted_at IS NULL AND o.deleted_at IS NULL
ORDER BY p.id;
