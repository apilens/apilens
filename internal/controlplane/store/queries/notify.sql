-- Recipients of the project change emails (internal/controlplane/notify).

-- name: ListProjectAdminRecipients :many
-- The effective admins of a project (ADR 0009, D1 in #753): org owners and
-- admins, and members with a direct admin grant (default access never grants
-- admin). A project deleted but not yet purged still has admins, so the
-- deletion email reaches them. security_emails is the user's preference, on
-- unless set to false.
SELECT u.id AS user_id, u.email::text AS email, u.name,
       (COALESCE(u.preferences->>'security_emails', 'true') <> 'false')::bool AS security_emails,
       p.name AS project_name, p.slug AS project_slug
FROM projects p
JOIN memberships m ON m.org_id = p.org_id
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = m.user_id
WHERE p.id = @project_id
  AND (m.role IN ('owner', 'admin') OR pm.role = 'admin')
ORDER BY u.email, u.id;

-- name: GetNotifyActor :one
-- The display name of the user who made a change: their name, or their
-- email when they have not set one.
SELECT COALESCE(NULLIF(btrim(name), ''), email::text)::text AS display
FROM users WHERE id = @id;
