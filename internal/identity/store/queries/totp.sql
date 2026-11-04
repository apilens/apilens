-- name: UpsertPendingTOTP :one
-- Stores a new, unconfirmed TOTP secret for a user (enable step 1). Only
-- identity reads or writes user_totp (ADR 0005); secret_enc is ciphertext,
-- never the secret itself. A pending secret is replaced; a confirmed one is
-- kept, and then this returns pgx.ErrNoRows (2FA is already enabled).
INSERT INTO user_totp (user_id, secret_enc)
VALUES (@user_id, @secret_enc)
ON CONFLICT (user_id) DO UPDATE
SET secret_enc = EXCLUDED.secret_enc,
    created_at = now()
WHERE user_totp.confirmed_at IS NULL
RETURNING *;

-- name: GetTOTPForUser :one
-- A user's TOTP row, confirmed or not. Returns pgx.ErrNoRows when the user
-- has never started enabling 2FA (or has turned it off).
SELECT * FROM user_totp
WHERE user_id = @user_id;

-- name: ConfirmTOTP :one
-- Marks a pending secret confirmed after the first valid code (enable step
-- 2). Returns pgx.ErrNoRows when there is no pending secret (none at all, or
-- already confirmed); of two concurrent confirms only one succeeds.
UPDATE user_totp
SET confirmed_at = now()
WHERE user_id = @user_id AND confirmed_at IS NULL
RETURNING *;

-- name: DeleteTOTP :execrows
-- Turns 2FA off for a user (disable, recovery). Delete the user's backup
-- codes in the same transaction. Returns 0 when the user had no secret.
DELETE FROM user_totp
WHERE user_id = @user_id;
