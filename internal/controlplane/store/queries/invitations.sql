-- token_hash is the SHA-256 of the emailed token, never the token itself.
-- An invitation is pending while accepted_at IS NULL AND revoked_at IS NULL.

-- name: CreateInvitation :one
-- Fails on invitations_org_email_pending if the address already has a
-- pending invitation to the organization.
INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
VALUES (@id, @org_id, @email, @role, @token_hash, sqlc.narg(invited_by), @expires_at)
RETURNING *;

-- name: GetInvitation :one
SELECT * FROM invitations
WHERE id = @id AND org_id = @org_id;

-- name: GetInvitationByTokenHash :one
-- Returns the row whatever its state, with its organization, so the caller
-- can tell a pending invitation from an accepted, revoked or expired one.
SELECT i.id, i.org_id, i.email, i.role, i.invited_by, i.created_at, i.expires_at,
       i.accepted_at, i.revoked_at, i.resent_at, o.slug AS org_slug, o.name AS org_name
FROM invitations i
JOIN organizations o ON o.id = i.org_id
WHERE i.token_hash = @token_hash AND o.deleted_at IS NULL;

-- name: ListPendingInvitations :many
SELECT * FROM invitations
WHERE org_id = @org_id AND accepted_at IS NULL AND revoked_at IS NULL
ORDER BY created_at DESC;

-- name: ResendInvitation :one
-- Rotates the token and extends the expiry of a pending invitation.
UPDATE invitations
SET token_hash = @token_hash,
    expires_at = @expires_at,
    resent_at  = now()
WHERE id = @id AND org_id = @org_id
  AND accepted_at IS NULL AND revoked_at IS NULL
RETURNING *;

-- name: RevokeInvitation :one
UPDATE invitations SET revoked_at = now()
WHERE id = @id AND org_id = @org_id
  AND accepted_at IS NULL AND revoked_at IS NULL
RETURNING *;

-- name: AcceptInvitation :one
-- Marks a pending, unexpired invitation accepted; returns pgx.ErrNoRows
-- otherwise. Of two concurrent accepts only one succeeds. The caller creates
-- the membership in the same transaction.
UPDATE invitations SET accepted_at = now()
WHERE id = @id
  AND accepted_at IS NULL AND revoked_at IS NULL
  AND expires_at > now()
RETURNING *;
