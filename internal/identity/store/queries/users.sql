-- name: CreateUser :one
-- Only the identity module reads or writes users (ADR 0005); every lookup
-- and update below ignores soft-deleted rows.
INSERT INTO users (id, email, email_verified_at, name, avatar_url)
VALUES (@id, @email, sqlc.narg('email_verified_at'), @name, @avatar_url)
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
UPDATE users
SET deleted_at   = NULL,
    delete_after = NULL,
    updated_at   = now()
WHERE id = @id AND deleted_at IS NOT NULL
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
