-- name: CreateOAuthClient :one
-- Registers a client. secret_hash is the SHA-256 (hex) of the client secret,
-- NULL for a public client (auth_method 'none').
INSERT INTO oauth_clients (id, name, secret_hash, auth_method, application_type, redirect_uris, grant_types)
VALUES (@id, @name, @secret_hash, @auth_method, @application_type, @redirect_uris, @grant_types)
RETURNING *;

-- name: GetOAuthClient :one
-- An active (not revoked) client. Returns pgx.ErrNoRows otherwise.
SELECT * FROM oauth_clients
WHERE id = @id AND revoked_at IS NULL;

-- name: CreateOAuthAuthRequest :one
INSERT INTO oauth_auth_requests (
    id, client_id, redirect_uri, scopes, response_type, response_mode, state, nonce,
    code_challenge, code_challenge_method, prompt, max_age_seconds, login_hint, expires_at
) VALUES (
    @id, @client_id, @redirect_uri, @scopes, @response_type, @response_mode, @state, @nonce,
    @code_challenge, @code_challenge_method, @prompt, @max_age_seconds, @login_hint, @expires_at
)
RETURNING *;

-- name: GetOAuthAuthRequest :one
-- An unexpired authorization request. Returns pgx.ErrNoRows otherwise.
SELECT * FROM oauth_auth_requests
WHERE id = @id AND expires_at > now();

-- name: CompleteOAuthAuthRequest :one
-- Binds the signed-in user to an unexpired request that has no user yet.
-- Returns pgx.ErrNoRows if the request is unknown, expired or already done.
UPDATE oauth_auth_requests
SET user_id = @user_id, amr = @amr, auth_time = @auth_time
WHERE id = @id AND user_id IS NULL AND expires_at > now()
RETURNING *;

-- name: SaveOAuthAuthCode :execrows
-- Records the code issued for a done request. A request gets one code: a
-- second callback for the same request matches no row. The code expires
-- with the request, which is shortened to code_expires_at.
UPDATE oauth_auth_requests
SET code_hash = @code_hash, expires_at = LEAST(expires_at, @code_expires_at)
WHERE id = @id AND user_id IS NOT NULL AND code_hash IS NULL AND expires_at > now();

-- name: ConsumeOAuthAuthCode :one
-- Redeems an authorization code: deletes and returns its request, so a code
-- is accepted at most once even under concurrent redemption. Returns
-- pgx.ErrNoRows for an unknown, used or expired code.
DELETE FROM oauth_auth_requests
WHERE code_hash = @code_hash AND expires_at > now()
RETURNING *;

-- name: DeleteOAuthAuthRequest :exec
DELETE FROM oauth_auth_requests
WHERE id = @id;

-- name: CreateOAuthToken :one
INSERT INTO oauth_tokens (
    id, client_id, user_id, scopes, audience, amr, auth_time, expires_at,
    refresh_token_hash, refresh_expires_at
) VALUES (
    @id, @client_id, @user_id, @scopes, @audience, @amr, @auth_time, @expires_at,
    @refresh_token_hash, @refresh_expires_at
)
RETURNING *;

-- name: GetActiveOAuthToken :one
-- An access token that is neither revoked nor expired. Returns pgx.ErrNoRows
-- otherwise.
SELECT * FROM oauth_tokens
WHERE id = @id AND revoked_at IS NULL AND expires_at > now();

-- name: GetOAuthTokenByRefreshHash :one
-- The live row holding a refresh token. Returns pgx.ErrNoRows for an
-- unknown, revoked (rotated) or expired refresh token.
SELECT * FROM oauth_tokens
WHERE refresh_token_hash = @refresh_token_hash
  AND revoked_at IS NULL
  AND refresh_expires_at > now();

-- name: RevokeOAuthRefreshToken :one
-- Rotates a refresh token out: revokes its live row and returns it. Of two
-- concurrent refreshes with the same token only one gets the row.
UPDATE oauth_tokens
SET revoked_at = now()
WHERE refresh_token_hash = @refresh_token_hash
  AND revoked_at IS NULL
  AND refresh_expires_at > now()
RETURNING *;

-- name: RevokeOAuthToken :execrows
-- Revokes one token row (and the refresh token it carries) of a client.
UPDATE oauth_tokens
SET revoked_at = now()
WHERE id = @id AND client_id = @client_id AND revoked_at IS NULL;

-- name: RevokeOAuthTokensForUserClient :execrows
-- Signs a user out of one client: revokes every token it holds for them.
UPDATE oauth_tokens
SET revoked_at = now()
WHERE user_id = @user_id AND client_id = @client_id AND revoked_at IS NULL;
