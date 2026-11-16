-- The authz reconciler (ADR 0006) compares these with SpiceDB. They describe
-- the relationships the outbox relay leaves behind once it has applied every
-- row: one org role per membership of an active organization; per active
-- project of an active organization one project#org, the default relations
-- its default_access implies (ADR 0009) and one direct role per
-- project_members row.

-- name: ListReconcileMemberships :many
SELECT m.org_id, m.user_id, m.role
FROM memberships m
JOIN organizations o ON o.id = m.org_id
WHERE o.deleted_at IS NULL
ORDER BY m.org_id, m.user_id;

-- name: ListReconcileProjects :many
SELECT p.id, p.org_id, p.default_access
FROM projects p
JOIN organizations o ON o.id = p.org_id
WHERE p.deleted_at IS NULL AND o.deleted_at IS NULL
ORDER BY p.id;

-- name: ListReconcileProjectMembers :many
SELECT pm.project_id, p.org_id, pm.user_id, pm.role
FROM project_members pm
JOIN projects p ON p.id = pm.project_id
JOIN organizations o ON o.id = p.org_id
WHERE p.deleted_at IS NULL AND o.deleted_at IS NULL
ORDER BY pm.project_id, pm.user_id;
