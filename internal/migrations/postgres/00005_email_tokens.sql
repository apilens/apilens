-- Identity schema: email sign-in tokens (magic link + 6-digit code).
-- Owned by the identity module (internal/identity); only identity reads or
-- writes this table (ADR 0005).
--
--   users 1 ──< auth_email_tokens.user_id   (NULL until the email has an account,
--                                            e.g. intent 'signup')
--
-- One email carries both a magic link and a 6-digit code; both are issued
-- together and share this one row, so using either consumes the other.
-- link_token_hash and code_hash are hashes of the secrets; the link token and
-- the code themselves are never stored. attempts counts wrong code guesses so
-- the caller can lock the row out after a few.
--
-- A row is live while consumed_at IS NULL AND expires_at > now(). Issuing a new
-- email invalidates the address's outstanding rows by setting consumed_at, so
-- only the latest link/code works. Consumed and expired rows are kept for a
-- purge job.
--
-- next_path is where the browser lands after signing in. It must be a relative
-- path on this site ("/projects/x?tab=y"): it starts with a single '/' (not
-- '//' or '/\', which browsers treat as another host), has no whitespace or
-- control characters and is at most 512 characters. The check enforces this
-- on every write, so an open redirect cannot be stored.

-- +goose Up
CREATE TABLE IF NOT EXISTS auth_email_tokens (
    id               uuid PRIMARY KEY,
    email            citext      NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
    intent           text        NOT NULL CHECK (intent IN ('signin', 'signup', 'verify_email', 'change_email')),
    user_id          uuid        REFERENCES users (id) ON DELETE CASCADE,
    link_token_hash  text        NOT NULL UNIQUE CHECK (length(link_token_hash) > 0),
    code_hash        text        NOT NULL CHECK (length(code_hash) > 0),
    attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_path        text        CHECK (
        next_path IS NULL OR (
            length(next_path) BETWEEN 1 AND 512
            AND next_path ~ '^/([^/\\]|$)'
            AND next_path !~ '[[:space:][:cntrl:]]'
        )
    ),
    ip               inet,
    user_agent       text        NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    consumed_at      timestamptz
);
-- Latest token for an address (code entry, resend throttling, invalidation).
CREATE INDEX IF NOT EXISTS auth_email_tokens_email_created
    ON auth_email_tokens (email, created_at DESC);
-- Backs ON DELETE CASCADE from users.
CREATE INDEX IF NOT EXISTS auth_email_tokens_user
    ON auth_email_tokens (user_id) WHERE user_id IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS auth_email_tokens;
