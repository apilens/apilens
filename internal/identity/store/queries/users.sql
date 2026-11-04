-- name: CreateUser :one
-- Only the identity module reads or writes users (ADR 0005); every lookup
-- and update below ignores soft-deleted rows.
INSERT INTO users (id, email, email_verified_at, name, avatar_url)
VALUES (@id, @email, sqlc.narg('email_verified_at'), @name, @avatar_url)
RETURNING *;

-- name: CreateFirstLoginUser :one
-- The first sign-in of a verified address (users.FindOrCreateByVerifiedEmail):
-- the user starts verified, signed in, and with the default preferences and
-- onboarding state.
INSERT INTO users (id, email, email_verified_at, preferences, onboarding, last_login_at)
VALUES (@id, @email, @email_verified_at, @preferences::jsonb, @onboarding::jsonb, @last_login_at)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users
WHERE id = @id AND deleted_at IS NULL;

-- name: GetUserByEmail :one
-- Case-insensitive; served by the users_email_active index on lower(email).
SELECT * FROM users
WHERE lower(email) = lower(@email::text) AND deleted_at IS NULL;

-- name: UpdateUserProfile :one
-- NULL arguments leave the column unchanged.
UPDATE users
SET name       = COALESCE(sqlc.narg('name'), name),
    avatar_url = COALESCE(sqlc.narg('avatar_url'), avatar_url),
    updated_at = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserPreferences :one
-- Shallow-merges the patch object into the stored preferences.
UPDATE users
SET preferences = preferences || @patch::jsonb,
    updated_at  = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserOnboarding :one
-- Shallow-merges the patch object into the stored onboarding state.
UPDATE users
SET onboarding = onboarding || @patch::jsonb,
    updated_at = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: TouchLastLogin :exec
UPDATE users
SET last_login_at = now()
WHERE id = @id AND deleted_at IS NULL;

-- name: SoftDeleteUser :one
-- Hides the user and schedules the hard delete; the purge job removes the
-- row once delete_after has passed.
UPDATE users
SET deleted_at   = now(),
    delete_after = CAST(@delete_after AS timestamptz),
    updated_at   = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: RestoreUser :one
-- Undoes a soft delete inside the grace period. Fails with a unique
-- violation if the email has since been taken by a new active account.
-- Returns pgx.ErrNoRows once delete_after has passed.
UPDATE users
SET deleted_at   = NULL,
    delete_after = NULL,
    updated_at   = now()
WHERE id = @id AND deleted_at IS NOT NULL AND delete_after > now()
RETURNING *;

-- name: UpdateUserEmail :one
-- Sets a new, verified email (an email change confirmed with a code sent to
-- the new address). Fails with a unique violation on users_email_active if
-- another active account has the address.
UPDATE users
SET email             = @email,
    email_verified_at = now(),
    updated_at        = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: MarkUserEmailVerified :one
-- Records that the user proved control of their address (an email code or
-- link). An earlier verification time is kept.
UPDATE users
SET email_verified_at = COALESCE(email_verified_at, now()),
    updated_at        = now()
WHERE id = @id AND deleted_at IS NULL
RETURNING *;

-- name: GetPendingDeletionUserByEmail :one
-- The soft-deleted account of an address that is still inside its grace
-- period, so sign-in can answer account_deleting and offer a restore. An
-- address that has since signed up again has an active account, which wins:
-- no row is returned for it.
SELECT * FROM users u
WHERE lower(u.email) = lower(@email::text)
  AND u.deleted_at IS NOT NULL
  AND u.delete_after > now()
  AND NOT EXISTS (
      SELECT 1 FROM users a
      WHERE lower(a.email) = lower(u.email) AND a.deleted_at IS NULL
  )
ORDER BY u.deleted_at DESC, u.id DESC
LIMIT 1;

-- name: ListPurgeableUsers :many
-- Soft-deleted users whose grace period has passed, oldest first, locked so
-- concurrent purges skip each other's rows. Served by users_delete_after.
SELECT id FROM users
WHERE deleted_at IS NOT NULL AND delete_after < now()
ORDER BY delete_after, id
LIMIT @batch_size
FOR UPDATE SKIP LOCKED;

-- name: AnonymizeAuditEventsForUsers :execrows
-- Keeps the audit trail of purged users but strips what identifies them:
-- events about them lose user_id and metadata, events they acted in lose
-- actor_user_id, and both lose the client IP and user agent. Run before
-- PurgeUsers, whose cascade would otherwise delete the events.
UPDATE audit_events
SET user_id       = CASE WHEN user_id = ANY(@ids::uuid[]) THEN NULL ELSE user_id END,
    actor_user_id = CASE WHEN actor_user_id = ANY(@ids::uuid[]) THEN NULL ELSE actor_user_id END,
    metadata      = CASE WHEN user_id = ANY(@ids::uuid[]) THEN '{}'::jsonb ELSE metadata END,
    ip            = NULL,
    user_agent    = ''
WHERE user_id = ANY(@ids::uuid[]) OR actor_user_id = ANY(@ids::uuid[]);

-- name: PurgeUsers :execrows
-- Hard-deletes soft-deleted users whose grace period has passed. Sessions,
-- email tokens, OAuth identities, passkeys and TOTP rows cascade.
DELETE FROM users
WHERE id = ANY(@ids::uuid[]) AND deleted_at IS NOT NULL AND delete_after < now();
