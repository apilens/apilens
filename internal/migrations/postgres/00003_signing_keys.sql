-- Identity schema: JWT signing keys.
-- Owned by the identity module (internal/identity/keys); only identity
-- processes read this table or hold the key encryption key (ADR 0005).
--
-- A key moves through three states:
--   created    activated_at IS NULL                  published, not yet signing
--   active     activated_at set, retired_at IS NULL  signs new tokens (one at a time)
--   retired    retired_at set                        published only, never signs
--
-- Retired keys stay in JWKS for identity.refresh_token_ttl after retired_at,
-- the longest lifetime of anything identity signs, so tokens minted just
-- before a rotation keep verifying until they expire. Rows older than that
-- window are no longer served and may be deleted.
--
-- private_key_enc is the PKCS#8 DER private key sealed with AES-256-GCM under
-- identity.key_encryption_key, with the kid as additional data; a database
-- dump without the KEK reveals no key material. public_jwk is the public
-- half exactly as served in JWKS.

-- +goose Up
CREATE TABLE IF NOT EXISTS signing_keys (
    kid              text        PRIMARY KEY CHECK (length(kid) BETWEEN 1 AND 128),
    alg              text        NOT NULL CHECK (alg IN ('RS256')),
    public_jwk       jsonb       NOT NULL CHECK (jsonb_typeof(public_jwk) = 'object'),
    private_key_enc  bytea       NOT NULL CHECK (length(private_key_enc) > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    activated_at     timestamptz,
    retired_at       timestamptz,
    CHECK (retired_at IS NULL OR activated_at IS NOT NULL)
);
-- At most one key signs at a time; rotation retires the old key first.
CREATE UNIQUE INDEX IF NOT EXISTS signing_keys_one_active
    ON signing_keys ((true)) WHERE activated_at IS NOT NULL AND retired_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS signing_keys;
