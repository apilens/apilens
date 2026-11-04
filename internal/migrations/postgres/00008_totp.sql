-- Identity schema: two-factor auth (TOTP secrets, backup codes, recovery).
-- Owned by the identity module (internal/identity); only identity reads or
-- writes these tables (ADR 0005).
--
--   users 1 ── 0..1 user_totp.user_id
--   users 1 ──<     backup_codes.user_id
--   users 1 ──<     recovery_requests.user_id
--
-- user_totp holds a user's authenticator secret, encrypted at rest with the
-- identity key-encryption key (secret_enc is ciphertext; the base32 secret is
-- never stored in the clear). Enabling 2FA writes the row unconfirmed
-- (confirmed_at IS NULL); the first valid code sets confirmed_at, and only a
-- confirmed row makes sign-in ask for a second factor. Re-enabling before
-- confirmation replaces the pending secret.
--
-- backup_codes are single-use codes handed out once when 2FA is confirmed or
-- the codes are regenerated. code_hash is a hash of the code; the code itself
-- is never stored. A code is usable while used_at IS NULL; regenerating
-- deletes the user's old codes.
--
-- recovery_requests let a user who lost their authenticator turn 2FA off by
-- email, after a cooling-off period: a request is made at requested_at and
-- can be confirmed only once ready_at has passed, which leaves time to cancel
-- it from the emailed link if the inbox is compromised. token_hash is the
-- SHA-256 of the emailed token; the token itself is never stored. A request
-- is pending while confirmed_at IS NULL AND cancelled_at IS NULL; at most one
-- of the two is ever set.

-- +goose Up
CREATE TABLE IF NOT EXISTS user_totp (
    user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    secret_enc    bytea       NOT NULL CHECK (length(secret_enc) > 0),
    confirmed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backup_codes (
    id          uuid PRIMARY KEY,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash   text        NOT NULL CHECK (length(code_hash) > 0),
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- The same code twice for one user would make one of them unusable.
    UNIQUE (user_id, code_hash)
);
-- The user_id-leading unique index above serves lookups, counts and the
-- ON DELETE CASCADE from users.

CREATE TABLE IF NOT EXISTS recovery_requests (
    id            uuid PRIMARY KEY,
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash    text        NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    requested_at  timestamptz NOT NULL DEFAULT now(),
    ready_at      timestamptz NOT NULL,
    confirmed_at  timestamptz,
    cancelled_at  timestamptz,
    ip            inet,
    user_agent    text        NOT NULL DEFAULT '',
    CHECK (ready_at >= requested_at),
    -- A request ends either confirmed or cancelled, never both.
    CHECK (confirmed_at IS NULL OR cancelled_at IS NULL)
);
-- A user's requests (pending lookup, cancelling older ones); backs ON DELETE
-- CASCADE from users.
CREATE INDEX IF NOT EXISTS recovery_requests_user
    ON recovery_requests (user_id, requested_at DESC);

-- +goose Down
DROP TABLE IF EXISTS recovery_requests;
DROP TABLE IF EXISTS backup_codes;
DROP TABLE IF EXISTS user_totp;
