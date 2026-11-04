-- name: CreateSession :one
-- Starts a new session family at sign-in: pass family_id = id. Only identity
-- reads or writes sessions (ADR 0005); token_hash is the SHA-256 of the
-- refresh token, never the token itself.
INSERT INTO sessions (id, user_id, family_id, token_hash, remember, amr, ip, user_agent, device_label, expires_at)
VALUES (@id, @user_id, @family_id, @token_hash, @remember, @amr::text[], sqlc.narg('ip'), @user_agent, @device_label, @expires_at)
RETURNING *;

-- name: GetSessionByTokenHash :one
-- Returns the row whatever its state, so the caller can tell a live token
-- from a revoked one (reuse) or an expired one.
SELECT * FROM sessions
WHERE token_hash = @token_hash;

-- name: RotateSession :one
-- Atomically revokes the live parent (reason 'rotated') and inserts its child
-- in the same family with a new token. The child inherits user, family,
-- remember, amr, device_label and created_at (the sign-in time). Returns
-- pgx.ErrNoRows when the parent is not live (already rotated, revoked or
-- expired); of two concurrent rotations of one parent only one succeeds.
WITH parent AS (
    UPDATE sessions
    SET revoked_at     = now(),
        revoked_reason = 'rotated'
    WHERE sessions.id = @parent_id
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > now()
    RETURNING sessions.*
)
INSERT INTO sessions (id, user_id, family_id, token_hash, parent_id, remember, amr, ip, user_agent, device_label, created_at, last_seen_at, expires_at)
SELECT @id, parent.user_id, parent.family_id, @token_hash, parent.id, parent.remember, parent.amr,
       sqlc.narg('ip'), @user_agent, parent.device_label, parent.created_at, now(), @expires_at
FROM parent
RETURNING *;

-- name: RevokeSession :execrows
-- Revokes one live session of a user (logout, or "sign out" in the sessions
-- list). Scoped by user_id so a user can only revoke their own.
UPDATE sessions
SET revoked_at     = now(),
    revoked_reason = CAST(@reason AS text)
WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL;

-- name: RevokeFamily :execrows
-- Revokes every live row of a family, e.g. on refresh-token reuse.
UPDATE sessions
SET revoked_at     = now(),
    revoked_reason = CAST(@reason AS text)
WHERE family_id = @family_id AND revoked_at IS NULL;

-- name: RevokeAllForUser :execrows
-- "Sign out everywhere".
UPDATE sessions
SET revoked_at     = now(),
    revoked_reason = CAST(@reason AS text)
WHERE user_id = @user_id AND revoked_at IS NULL;

-- name: RevokeOthersForUser :execrows
-- "Sign out other sessions": revokes every live session of the user except
-- the family of the current one.
UPDATE sessions
SET revoked_at     = now(),
    revoked_reason = CAST(@reason AS text)
WHERE user_id = @user_id AND family_id <> @keep_family_id AND revoked_at IS NULL;

-- name: ListActiveSessionsForUser :many
-- The settings "Sessions" list: live rows only (one per family), most
-- recently used first.
SELECT * FROM sessions
WHERE user_id = @user_id AND revoked_at IS NULL AND expires_at > now()
ORDER BY last_seen_at DESC, id;

-- name: TouchSession :execrows
-- Records activity on a live session. A NULL ip keeps the stored one.
UPDATE sessions
SET last_seen_at = now(),
    ip           = COALESCE(sqlc.narg('ip'), ip)
WHERE id = @id AND revoked_at IS NULL AND expires_at > now();
