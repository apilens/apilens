-- Control-plane schema: organization memberships, invitations and joining an
-- organization by verified email domain. Owned by the api role
-- (internal/controlplane); users are referenced by users.id only (ADR 0005).
-- Every write that changes who can see what also writes an outbox row in the
-- same transaction (ADR 0006).
--
--   organizations 1 ──< memberships.org_id
--   users         1 ──< memberships.user_id
--   organizations 1 ──< invitations.org_id
--   users         1 ──< memberships.invited_by, invitations.invited_by,
--                       organizations.created_by   (NULL once the user is gone)
--
-- memberships: one row per (org, user) with the user's role. Roles, most to
-- least privileged: owner, admin, member, viewer.
--
-- Last owner: an organization must always keep at least one owner. That rule
-- is enforced in the service layer, NOT here: every write that demotes or
-- removes an owner (change role, remove member, leave, transfer ownership)
-- locks the organization row (LockOrganization), counts the remaining owners
-- (CountOrgOwners) and refuses the change if it would leave none, all in one
-- transaction. A trigger cannot tell "last owner leaves" from "the whole
-- organization is being deleted" and would turn a domain error into an opaque
-- SQL error, so the database deliberately does not check it.
--
-- invitations: an emailed, single-use invitation to join an organization with
-- a role. token_hash is the SHA-256 of the emailed token; the token itself is
-- never stored. An invitation is pending while accepted_at IS NULL AND
-- revoked_at IS NULL (and usable while expires_at is in the future); at most
-- one pending invitation exists per (org, email). Resending rotates
-- token_hash, pushes expires_at out and sets resent_at.
--
-- organizations.allowed_domains / domain_join: when domain_join is on, a user
-- whose verified email is at one of allowed_domains (lower-case, no "@") may
-- join the organization as a member without an invitation.

-- +goose Up
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS allowed_domains text[] NOT NULL DEFAULT '{}'
        CONSTRAINT organizations_allowed_domains_lower
        CHECK (allowed_domains::text = lower(allowed_domains::text)),
    ADD COLUMN IF NOT EXISTS domain_join boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users (id) ON DELETE SET NULL;
-- "Which organizations can I join with my email domain?"
CREATE INDEX IF NOT EXISTS organizations_allowed_domains
    ON organizations USING gin (allowed_domains)
    WHERE domain_join AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS memberships (
    org_id      uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        text        NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    invited_by  uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id)
);
-- A user's organizations; backs ON DELETE CASCADE from users.
CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id);

CREATE TABLE IF NOT EXISTS invitations (
    id           uuid PRIMARY KEY,
    org_id       uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email        citext      NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
    role         text        NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    token_hash   text        NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    invited_by   uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days',
    accepted_at  timestamptz,
    revoked_at   timestamptz,
    resent_at    timestamptz,
    CHECK (expires_at > created_at),
    -- An invitation ends either accepted or revoked, never both.
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
-- At most one pending invitation per address and organization (citext, so
-- case-insensitively); also serves listing an organization's pending ones.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_org_email_pending
    ON invitations (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- Backs ON DELETE CASCADE from organizations for non-pending rows.
CREATE INDEX IF NOT EXISTS invitations_org ON invitations (org_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS memberships;
DROP INDEX IF EXISTS organizations_allowed_domains;
ALTER TABLE organizations
    DROP COLUMN IF EXISTS created_by,
    DROP COLUMN IF EXISTS domain_join,
    DROP COLUMN IF EXISTS allowed_domains;
