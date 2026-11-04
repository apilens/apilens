-- Identity schema: OAuth sign-in identities (Google, GitHub).
-- Owned by the identity module (internal/identity); only identity reads or
-- writes this table (ADR 0005).
--
--   users 1 ──< oauth_identities.user_id
--
-- One user can link several providers, and one provider account (provider,
-- subject) maps to exactly one user. subject is the provider's stable user id
-- (OIDC `sub` for Google, the numeric user id for GitHub), never the email,
-- which a provider account can change. email is what the provider reported
-- (NULL when it shared none); profile keeps the rest of the provider's profile
-- (name, avatar, login) as returned. last_login_at is the last sign-in through
-- this identity; NULL when it was linked but never used to sign in.

-- +goose Up
CREATE TABLE IF NOT EXISTS oauth_identities (
    id             uuid PRIMARY KEY,
    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider       text        NOT NULL CHECK (provider IN ('google', 'github')),
    subject        text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
    email          citext      CHECK (email IS NULL OR length(email) BETWEEN 3 AND 320),
    profile        jsonb       NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at  timestamptz,
    UNIQUE (provider, subject)
);
-- A user's linked providers (settings list, unlink guard); backs ON DELETE
-- CASCADE from users.
CREATE INDEX IF NOT EXISTS oauth_identities_user
    ON oauth_identities (user_id);

-- +goose Down
DROP TABLE IF EXISTS oauth_identities;
