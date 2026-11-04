-- Identity schema: users and their audit trail.
-- Owned by the identity module (internal/identity); no other module writes
-- these tables. Other modules refer to a user by users.id only.
--
--   users 1 ──< audit_events.user_id        (whose account the event is about)
--   users 1 ──< audit_events.actor_user_id  (who did it; NULL = system/anonymous)
--
-- Users are soft-deleted: deleted_at hides the row and frees the email for a
-- new account; a purge job hard-deletes rows once delete_after has passed,
-- which cascades to the user's audit events.

-- +goose Up
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
    id                 uuid PRIMARY KEY,
    email              citext      NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
    email_verified_at  timestamptz,
    name               text        NOT NULL DEFAULT '',
    avatar_url         text        NOT NULL DEFAULT '',
    preferences        jsonb       NOT NULL DEFAULT '{}',
    onboarding         jsonb       NOT NULL DEFAULT '{}',
    last_login_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    delete_after       timestamptz
);
-- Emails are unique among active users only, so a deleted account's address
-- can sign up again.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active
    ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_delete_after
    ON users (delete_after) WHERE delete_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        uuid        REFERENCES users (id) ON DELETE CASCADE,
    actor_user_id  uuid        REFERENCES users (id) ON DELETE SET NULL,
    event          text        NOT NULL,
    ip             inet,
    user_agent     text        NOT NULL DEFAULT '',
    metadata       jsonb       NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_user_created
    ON audit_events (user_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS users;
DROP EXTENSION IF EXISTS citext;
