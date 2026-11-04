-- Identity schema: APILens as an OpenID Connect provider / OAuth 2.0
-- authorization server (ADR 0005), served by internal/identity/oidcprovider
-- on zitadel/oidc. Only identity reads or writes these tables.
--
--   oauth_clients 1 ──< oauth_auth_requests.client_id
--   oauth_clients 1 ──< oauth_tokens.client_id
--   users         1 ──< oauth_auth_requests.user_id   (once signed in)
--   users         1 ──< oauth_tokens.user_id          (NULL: client token)
--
-- oauth_clients: registered clients. id is the client_id. A confidential
-- client authenticates at the token endpoint with a secret (auth_method
-- client_secret_basic or client_secret_post); only the SHA-256 of the secret
-- (hex) is stored, the secret is shown once at registration. A public client
-- (auth_method none, e.g. a CLI) has no secret and must use PKCE.
-- grant_types are the grants the client may use; redirect_uris are matched
-- exactly. revoked_at disables a client without deleting its history.
--
-- oauth_auth_requests: one authorization request (GET /oauth/authorize)
-- from creation until its code is redeemed or it expires. It is "done" once
-- the user signed in through the UI and identity bound user_id, amr and
-- auth_time to it. code_hash is the SHA-256 (hex) of the authorization code
-- issued for it; the code itself is never stored. A row is deleted when its
-- code is redeemed; expired rows are left for a purge job.
--
-- oauth_tokens: one row per issued access token (id is the JWT `jti`),
-- carrying the refresh token issued with it, if any. user_id is NULL for a
-- client_credentials token, whose subject is the client. refresh_token_hash
-- is the SHA-256 (hex) of the opaque refresh token. Refreshing rotates: the
-- presented row is revoked and a new row is issued. userinfo and refresh
-- accept a row only while revoked_at IS NULL and it has not expired.

-- +goose Up
CREATE TABLE IF NOT EXISTS oauth_clients (
    id                 text PRIMARY KEY CHECK (length(id) > 0),
    name               text        NOT NULL DEFAULT '',
    secret_hash        text,
    auth_method        text        NOT NULL
        CHECK (auth_method IN ('client_secret_basic', 'client_secret_post', 'none')),
    application_type   text        NOT NULL DEFAULT 'web'
        CHECK (application_type IN ('web', 'native')),
    redirect_uris      text[]      NOT NULL DEFAULT '{}',
    grant_types        text[]      NOT NULL DEFAULT '{}'
        CONSTRAINT oauth_clients_grant_types
        CHECK (grant_types <@ ARRAY['authorization_code', 'refresh_token', 'client_credentials']::text[]),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    revoked_at         timestamptz,
    -- A client has a secret exactly when it authenticates with one.
    CHECK ((auth_method = 'none') = (secret_hash IS NULL)),
    CHECK (secret_hash IS NULL OR length(secret_hash) > 0),
    -- Only a confidential client may act on its own behalf.
    CHECK (auth_method <> 'none' OR NOT ('client_credentials' = ANY (grant_types)))
);

CREATE TABLE IF NOT EXISTS oauth_auth_requests (
    id                     uuid PRIMARY KEY,
    client_id              text        NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    redirect_uri           text        NOT NULL CHECK (length(redirect_uri) > 0),
    scopes                 text[]      NOT NULL DEFAULT '{}',
    response_type          text        NOT NULL CHECK (length(response_type) > 0),
    response_mode          text        NOT NULL DEFAULT '',
    state                  text        NOT NULL DEFAULT '',
    nonce                  text        NOT NULL DEFAULT '',
    code_challenge         text        NOT NULL DEFAULT '',
    code_challenge_method  text        NOT NULL DEFAULT '',
    prompt                 text[]      NOT NULL DEFAULT '{}',
    max_age_seconds        integer CHECK (max_age_seconds IS NULL OR max_age_seconds >= 0),
    login_hint             text        NOT NULL DEFAULT '',
    user_id                uuid REFERENCES users (id) ON DELETE CASCADE,
    amr                    text[]      NOT NULL DEFAULT '{}',
    auth_time              timestamptz,
    code_hash              text UNIQUE CHECK (code_hash IS NULL OR length(code_hash) > 0),
    created_at             timestamptz NOT NULL DEFAULT now(),
    expires_at             timestamptz NOT NULL,
    -- Done means signed in: the user and the time of authentication travel
    -- together.
    CHECK ((user_id IS NULL) = (auth_time IS NULL)),
    -- A code is only issued for a done request.
    CHECK (code_hash IS NULL OR user_id IS NOT NULL)
);
-- Purging expired requests.
CREATE INDEX IF NOT EXISTS oauth_auth_requests_expires
    ON oauth_auth_requests (expires_at);
-- Backs ON DELETE CASCADE from users.
CREATE INDEX IF NOT EXISTS oauth_auth_requests_user
    ON oauth_auth_requests (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id                  uuid PRIMARY KEY,
    client_id           text        NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    user_id             uuid REFERENCES users (id) ON DELETE CASCADE,
    scopes              text[]      NOT NULL DEFAULT '{}',
    audience            text[]      NOT NULL DEFAULT '{}',
    amr                 text[]      NOT NULL DEFAULT '{}',
    auth_time           timestamptz,
    expires_at          timestamptz NOT NULL,
    refresh_token_hash  text UNIQUE CHECK (refresh_token_hash IS NULL OR length(refresh_token_hash) > 0),
    refresh_expires_at  timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,
    -- A refresh token always has a lifetime, and is only issued to a user.
    CHECK ((refresh_token_hash IS NULL) = (refresh_expires_at IS NULL)),
    CHECK (refresh_token_hash IS NULL OR user_id IS NOT NULL)
);
-- A user's tokens for one client (sign-out of that client).
CREATE INDEX IF NOT EXISTS oauth_tokens_user_client
    ON oauth_tokens (user_id, client_id) WHERE user_id IS NOT NULL;
-- Backs ON DELETE CASCADE from oauth_clients.
CREATE INDEX IF NOT EXISTS oauth_tokens_client
    ON oauth_tokens (client_id);

-- +goose Down
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_auth_requests;
DROP TABLE IF EXISTS oauth_clients;
