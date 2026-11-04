-- name: CreatePasskeyCredential :one
-- Stores a credential after a verified registration ceremony. Only identity
-- reads or writes passkey_credentials (ADR 0005). A credential_id already
-- registered (to any user) violates the unique constraint.
INSERT INTO passkey_credentials (
    id, user_id, credential_id, public_key, attestation_type, aaguid,
    sign_count, transports, backup_eligible, backup_state, name
)
VALUES (
    @id, @user_id, @credential_id, @public_key, @attestation_type, @aaguid,
    @sign_count, @transports, @backup_eligible, @backup_state, @name
)
RETURNING *;

-- name: GetPasskeyCredentialByCredentialID :one
-- Resolves the rawId of a sign-in assertion to its credential (and so its
-- user). Returns pgx.ErrNoRows when the credential is not registered.
SELECT * FROM passkey_credentials
WHERE credential_id = @credential_id;

-- name: ListPasskeyCredentialsForUser :many
-- A user's passkeys, oldest first. Also feeds the exclude list of a
-- registration ceremony.
SELECT * FROM passkey_credentials
WHERE user_id = @user_id
ORDER BY created_at, id;

-- name: GetPasskeyCredentialForUser :one
-- One passkey of a user; scoped by user_id so a caller cannot read another
-- user's passkey. Returns pgx.ErrNoRows when nothing matched.
SELECT * FROM passkey_credentials
WHERE id = @id AND user_id = @user_id;

-- name: UpdatePasskeySignCount :execrows
-- Records a verified sign-in: the new signature counter, the current backup
-- state (BS) and last_used_at. The caller rejects a counter that went
-- backwards before calling this. Returns 0 when the credential is gone.
UPDATE passkey_credentials
SET sign_count = @sign_count,
    backup_state = @backup_state,
    last_used_at = now()
WHERE id = @id;

-- name: RenamePasskeyCredential :execrows
-- Renames one passkey of a user; scoped by user_id so a caller cannot rename
-- another user's passkey. Returns 0 when nothing matched.
UPDATE passkey_credentials
SET name = @name
WHERE id = @id AND user_id = @user_id;

-- name: DeletePasskeyCredential :execrows
-- Removes one passkey of a user; scoped by user_id so a caller cannot remove
-- another user's passkey. Returns 0 when nothing matched.
DELETE FROM passkey_credentials
WHERE id = @id AND user_id = @user_id;

-- name: CountPasskeyCredentialsForUser :one
-- Number of passkeys registered to a user.
SELECT count(*) FROM passkey_credentials
WHERE user_id = @user_id;
