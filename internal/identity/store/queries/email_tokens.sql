-- name: CreateEmailToken :one
-- Stores the row behind one sign-in email (magic link + 6-digit code). Only
-- identity reads or writes auth_email_tokens (ADR 0005); link_token_hash and
-- code_hash are hashes, never the secrets. next_path must be a relative path
-- (the table check rejects anything else). Call InvalidateEmailTokensForEmail
-- first so only the newest email works.
INSERT INTO auth_email_tokens (id, email, intent, user_id, link_token_hash, code_hash, next_path, ip, user_agent, expires_at)
VALUES (@id, @email, @intent, sqlc.narg('user_id'), @link_token_hash, @code_hash, sqlc.narg('next_path'), sqlc.narg('ip'), @user_agent, @expires_at)
RETURNING *;

-- name: GetEmailTokenByLinkHash :one
-- Returns the row whatever its state, so the caller can tell a live link from
-- a consumed or expired one.
SELECT * FROM auth_email_tokens
WHERE link_token_hash = @link_token_hash;

-- name: GetLatestEmailTokenForEmail :one
-- The newest live row for an address, used to check a typed 6-digit code.
-- Returns pgx.ErrNoRows when the address has no live token.
SELECT * FROM auth_email_tokens
WHERE email = @email AND consumed_at IS NULL AND expires_at > now()
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: GetLatestUnconsumedEmailTokenForEmail :one
-- The newest unconsumed row for an address, expired or not, so a typed code
-- can be told apart as expired rather than wrong. Issuing a new email
-- invalidates older rows, so this is the address's latest email.
-- Returns pgx.ErrNoRows when the address has no unconsumed token.
SELECT * FROM auth_email_tokens
WHERE email = @email AND consumed_at IS NULL
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: IncrementEmailTokenAttempts :one
-- Counts one wrong code guess on a live row and returns the new count.
-- Returns pgx.ErrNoRows when the row is no longer live.
UPDATE auth_email_tokens
SET attempts = attempts + 1
WHERE id = @id AND consumed_at IS NULL AND expires_at > now()
RETURNING attempts;

-- name: ConsumeEmailToken :one
-- Marks a live row used (by its link or its code). Returns pgx.ErrNoRows when
-- the row is already consumed or expired; of two concurrent consumes only one
-- succeeds.
UPDATE auth_email_tokens
SET consumed_at = now()
WHERE id = @id AND consumed_at IS NULL AND expires_at > now()
RETURNING *;

-- name: InvalidateEmailTokensForEmail :execrows
-- Retires every outstanding row of an address, e.g. before sending a new
-- email or once the address has signed in.
UPDATE auth_email_tokens
SET consumed_at = now()
WHERE email = @email AND consumed_at IS NULL;
