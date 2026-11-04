-- Identity schema: refresh-token sessions.
-- Owned by the identity module (internal/identity); only identity reads or
-- writes this table (ADR 0005). Other modules see a session only as the
-- `sid` claim of an access token.
--
--   users 1 ──< sessions.user_id
--   sessions 1 ──< sessions.parent_id   (the row this one was rotated from)
--
-- One row per refresh token. A sign-in starts a family (family_id = id of the
-- first row); every refresh rotates: the presented row is revoked with reason
-- 'rotated' and a child row with a new token joins the same family. A family
-- therefore has at most one live row, and that row is what the settings
-- "Sessions" list shows. Presenting a token whose row is already revoked is
-- reuse: the whole family is revoked.
--
-- token_hash is the SHA-256 of the opaque refresh token; the token itself is
-- never stored. created_at is carried across rotations so it stays the time
-- the family signed in; last_seen_at moves on every refresh or touch.
-- A row is live while revoked_at IS NULL AND expires_at > now(); revoked and
-- expired rows are kept for reuse detection until a purge job removes them.

-- +goose Up
CREATE TABLE IF NOT EXISTS sessions (
    id              uuid PRIMARY KEY,
    user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    family_id       uuid        NOT NULL,
    token_hash      text        NOT NULL UNIQUE CHECK (length(token_hash) > 0),
    parent_id       uuid        REFERENCES sessions (id) ON DELETE SET NULL,
    remember        boolean     NOT NULL DEFAULT false,
    amr             text[]      NOT NULL DEFAULT '{}',
    ip              inet,
    user_agent      text        NOT NULL DEFAULT '',
    device_label    text        NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    revoked_reason  text,
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
    CHECK (revoked_reason IS NULL OR length(revoked_reason) > 0)
);
-- Live sessions of a user (settings list, revoke all / others).
CREATE INDEX IF NOT EXISTS sessions_user_active
    ON sessions (user_id) WHERE revoked_at IS NULL;
-- Revoking a family on reuse or logout.
CREATE INDEX IF NOT EXISTS sessions_family
    ON sessions (family_id);
-- Backs ON DELETE SET NULL when a purge removes a parent row.
CREATE INDEX IF NOT EXISTS sessions_parent
    ON sessions (parent_id) WHERE parent_id IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS sessions;
