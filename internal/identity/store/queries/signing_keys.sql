-- name: InsertSigningKey :one
-- Only identity reads or writes signing keys (ADR 0005). Pass
-- activated_at = NULL to publish a key in JWKS before it signs.
INSERT INTO signing_keys (kid, alg, public_jwk, private_key_enc, activated_at)
VALUES (@kid, @alg, @public_jwk, @private_key_enc, sqlc.narg('activated_at'))
RETURNING *;

-- name: ListPublishedSigningKeys :many
-- The keys served in JWKS: every key not yet retired, plus keys retired less
-- than @retired_window_secs (identity.refresh_token_ttl) ago, measured on the
-- database clock. Active key first.
SELECT * FROM signing_keys
WHERE retired_at IS NULL
   OR retired_at > now() - make_interval(secs => @retired_window_secs::float8)
ORDER BY (activated_at IS NOT NULL AND retired_at IS NULL) DESC, created_at DESC, kid;

-- name: RetireSigningKey :one
-- Stops a key from signing; it stays published for the retirement window.
UPDATE signing_keys
SET retired_at   = now(),
    activated_at = COALESCE(activated_at, now())
WHERE kid = @kid AND retired_at IS NULL
RETURNING *;
