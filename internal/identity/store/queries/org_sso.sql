-- name: GetOrgSSOConnection :one
-- An organization's OIDC connection, for the SSO start and callback. Only
-- identity and the api role touch org_sso_connections (ADR 0005);
-- client_secret_enc is ciphertext, decrypt it with the identity
-- key-encryption key. Returns pgx.ErrNoRows when the organization has no
-- connection.
SELECT * FROM org_sso_connections
WHERE org_id = @org_id;

-- name: GetOrgSSOConnectionForDomain :one
-- The connection of an active organization that lists an email domain
-- (lower-case, no "@"), for the SSO lookup at sign-in. An enforcing
-- connection wins over non-enforcing ones; the service layer keeps a domain
-- enforced by at most one organization. Returns pgx.ErrNoRows when no
-- organization uses SSO for the domain.
SELECT c.* FROM org_sso_connections c
JOIN organizations o ON o.id = c.org_id
WHERE c.domains @> ARRAY[@domain::text]
  AND o.deleted_at IS NULL
ORDER BY c.enforce DESC, c.created_at, c.org_id
LIMIT 1;

-- name: TouchOrgSSOLastLogin :exec
-- Records a successful sign-in through an organization's connection.
UPDATE org_sso_connections
SET last_login_at = now()
WHERE org_id = @org_id;

-- name: LookupOrgSSOForDomain :one
-- What the public SSO lookup at sign-in may reveal about the active
-- organization that uses SSO for an email domain (lower-case, no "@"): its
-- slug (for the start URL), display name and whether SSO is enforced. Same
-- precedence as GetOrgSSOConnectionForDomain. Returns pgx.ErrNoRows when no
-- organization uses SSO for the domain.
SELECT o.slug, o.name, c.enforce FROM org_sso_connections c
JOIN organizations o ON o.id = c.org_id
WHERE c.domains @> ARRAY[@domain::text]
  AND o.deleted_at IS NULL
ORDER BY c.enforce DESC, c.created_at, c.org_id
LIMIT 1;
