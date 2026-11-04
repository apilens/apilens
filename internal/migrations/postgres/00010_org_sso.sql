-- Identity schema: per-organization single sign-on over OIDC. Owned by the
-- identity module (internal/identity), which reads a connection to run the
-- SSO sign-in and decide whether SSO is enforced for an email domain; the api
-- role manages the connection settings (ADR 0005).
--
--   organizations 1 ── 0..1 org_sso_connections.org_id
--
-- org_sso_connections: at most one OIDC connection per organization. issuer
-- is the provider's issuer URL (discovery is at
-- issuer/.well-known/openid-configuration); client_id is the client
-- registered with that provider. client_secret_enc is the client secret
-- encrypted at rest with the identity key-encryption key (ciphertext; the
-- secret is never stored in the clear).
--
-- domains are the email domains (lower-case, no "@") whose users sign in
-- through this connection. With enforce on, a user at one of those domains
-- must use SSO and cannot sign in by email code, OAuth or passkey. A user who
-- signs in through SSO and is not yet a member joins the organization with
-- default_role (never owner). That a domain is enforced by at most one
-- organization is checked by the service layer when domains are saved.
--
-- updated_at is set by the application on every change; last_login_at is
-- the time of the last successful sign-in through the connection (NULL until
-- the first one).

-- +goose Up
CREATE TABLE IF NOT EXISTS org_sso_connections (
    org_id             uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
    issuer             text        NOT NULL CHECK (length(issuer) > 0),
    client_id          text        NOT NULL CHECK (length(client_id) > 0),
    client_secret_enc  bytea       NOT NULL CHECK (length(client_secret_enc) > 0),
    domains            text[]      NOT NULL DEFAULT '{}'
        CONSTRAINT org_sso_connections_domains_lower
        CHECK (domains::text = lower(domains::text)),
    enforce            boolean     NOT NULL DEFAULT false,
    default_role       text        NOT NULL DEFAULT 'member'
        CHECK (default_role IN ('admin', 'member', 'viewer')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    last_login_at      timestamptz
);
-- "Is SSO configured (or enforced) for this email domain?"
CREATE INDEX IF NOT EXISTS org_sso_connections_domains
    ON org_sso_connections USING gin (domains);

-- +goose Down
DROP TABLE IF EXISTS org_sso_connections;
