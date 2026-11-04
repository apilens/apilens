-- Identity schema: passkeys (WebAuthn credentials, go-webauthn).
-- Owned by the identity module (internal/identity); only identity reads or
-- writes this table (ADR 0005).
--
--   users 1 ──< passkey_credentials.user_id
--
-- One row per registered credential. credential_id is the authenticator's raw
-- credential id (what a discoverable sign-in presents as rawId) and is unique
-- across all users; public_key is the COSE-encoded public key. aaguid names
-- the authenticator model (all zeros when the authenticator did not say);
-- attestation_type is the attestation format seen at registration ('none',
-- 'packed', ...). sign_count is the authenticator's signature counter: a
-- sign-in whose counter goes backwards (and is above 0) points to a cloned
-- authenticator. backup_eligible (BE) is fixed at registration; backup_state
-- (BS) is refreshed on every sign-in, since a credential can become synced
-- later. transports are the hints the browser reported ('usb', 'internal',
-- 'hybrid', ...). name is the user's label in settings. last_used_at is the
-- last sign-in with this passkey; NULL when it was registered but never used.

-- +goose Up
CREATE TABLE IF NOT EXISTS passkey_credentials (
    id                uuid PRIMARY KEY,
    user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    credential_id     bytea       NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 1 AND 1023),
    public_key        bytea       NOT NULL CHECK (length(public_key) > 0),
    attestation_type  text        NOT NULL DEFAULT '',
    aaguid            uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    sign_count        bigint      NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
    transports        text[]      NOT NULL DEFAULT '{}',
    backup_eligible   boolean     NOT NULL DEFAULT false,
    backup_state      boolean     NOT NULL DEFAULT false,
    name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_used_at      timestamptz,
    -- A credential that is not backup eligible can never be backed up.
    CHECK (backup_eligible OR NOT backup_state)
);
-- A user's passkeys (settings list, count); backs ON DELETE CASCADE from users.
CREATE INDEX IF NOT EXISTS passkey_credentials_user
    ON passkey_credentials (user_id);

-- +goose Down
DROP TABLE IF EXISTS passkey_credentials;
