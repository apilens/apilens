-- name: CreateBackupCodes :execrows
-- Stores a fresh set of backup codes for a user: ids[i] pairs with
-- code_hashes[i]. Only identity reads or writes backup_codes (ADR 0005);
-- code_hash is a hash of the code, never the code itself. Call
-- DeleteBackupCodesForUser first (same transaction) when regenerating.
INSERT INTO backup_codes (id, user_id, code_hash)
SELECT unnest(@ids::uuid[]), @user_id, unnest(@code_hashes::text[]);

-- name: UseBackupCode :one
-- Spends one unused backup code of a user. Returns pgx.ErrNoRows when the
-- code is wrong or already used; of two concurrent uses only one succeeds.
UPDATE backup_codes
SET used_at = now()
WHERE user_id = @user_id AND code_hash = @code_hash AND used_at IS NULL
RETURNING *;

-- name: CountUnusedBackupCodesForUser :one
-- Number of backup codes a user can still spend (2FA status).
SELECT count(*) FROM backup_codes
WHERE user_id = @user_id AND used_at IS NULL;

-- name: DeleteBackupCodesForUser :execrows
-- Removes all of a user's backup codes, used or not (regenerate, disable).
DELETE FROM backup_codes
WHERE user_id = @user_id;
