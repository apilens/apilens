-- name: GetOrgSSOConnection :one
-- An organization's OIDC connection, for its settings (GET, PUT and DELETE
-- /api/v1/orgs/{slug}/sso). client_secret_enc is ciphertext sealed with the
-- identity key-encryption key and is never returned by the API. Returns
-- pgx.ErrNoRows when the organization has no connection.
SELECT * FROM org_sso_connections
WHERE org_id = @org_id;

-- name: UpsertOrgSSOConnection :one
-- Creates or replaces an organization's OIDC connection. created_at and
-- last_login_at survive a replace.
INSERT INTO org_sso_connections (org_id, issuer, client_id, client_secret_enc, domains, enforce, default_role)
VALUES (@org_id, @issuer, @client_id, @client_secret_enc, @domains, @enforce, @default_role)
ON CONFLICT (org_id) DO UPDATE
SET issuer            = EXCLUDED.issuer,
    client_id         = EXCLUDED.client_id,
    client_secret_enc = EXCLUDED.client_secret_enc,
    domains           = EXCLUDED.domains,
    enforce           = EXCLUDED.enforce,
    default_role      = EXCLUDED.default_role,
    updated_at        = now()
RETURNING *;

-- name: DeleteOrgSSOConnection :execrows
DELETE FROM org_sso_connections
WHERE org_id = @org_id;

-- name: LockSSOEnforcement :exec
-- Serializes the transactions that save an enforcing connection, so two
-- organizations cannot both start enforcing one domain.
SELECT pg_advisory_xact_lock(hashtext('org_sso_connections.enforce'));

-- name: EnforcedSSODomainsOfOtherOrgs :many
-- The domains among @domains that another active organization enforces SSO
-- for. A domain is enforced by at most one organization.
SELECT DISTINCT d.domain::text AS domain
FROM org_sso_connections c
JOIN organizations o ON o.id = c.org_id
CROSS JOIN LATERAL unnest(c.domains) AS d(domain)
WHERE c.org_id <> @org_id
  AND c.enforce
  AND o.deleted_at IS NULL
  AND d.domain = ANY(@domains::text[])
ORDER BY 1;

-- name: HasSSOSignInSince :one
-- Whether user signed in through organization org's SSO connection (a
-- login.succeeded audit event with method sso for the organization) at or
-- after since.
SELECT EXISTS (
    SELECT 1 FROM audit_events
    WHERE user_id = @user_id
      AND event = 'login.succeeded'
      AND metadata->>'method' = 'sso'
      AND metadata->>'org_id' = @org_id::text
      AND created_at >= @since
) AS signed_in;
