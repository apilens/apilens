-- name: CreateRecoveryRequest :one
-- Stores a request to turn 2FA off by email. Only identity reads or writes
-- recovery_requests (ADR 0005); token_hash is the SHA-256 of the emailed
-- token, never the token itself. The caller passes requested_at and ready_at
-- (requested_at + the cooling-off delay) from its clock. Call
-- CancelPendingRecoveryRequestsForUser first so only the newest request works.
INSERT INTO recovery_requests (id, user_id, token_hash, requested_at, ready_at, ip, user_agent)
VALUES (@id, @user_id, @token_hash, @requested_at, @ready_at, sqlc.narg('ip'), @user_agent)
RETURNING *;

-- name: GetRecoveryRequestByTokenHash :one
-- Returns the row whatever its state, so the caller can tell a pending
-- request from a confirmed or cancelled one (status page).
SELECT * FROM recovery_requests
WHERE token_hash = @token_hash;

-- name: ConfirmRecoveryRequest :one
-- Completes a pending request whose cooling-off period has passed at now
-- (the caller's clock). Returns pgx.ErrNoRows when the request is not
-- pending or not ready yet; of two concurrent confirms only one succeeds.
UPDATE recovery_requests
SET confirmed_at = @now::timestamptz
WHERE id = @id
  AND confirmed_at IS NULL
  AND cancelled_at IS NULL
  AND ready_at <= @now::timestamptz
RETURNING *;

-- name: CancelRecoveryRequest :one
-- Cancels a pending request (the link in the request email). Returns
-- pgx.ErrNoRows when it is already confirmed or cancelled.
UPDATE recovery_requests
SET cancelled_at = @now::timestamptz
WHERE id = @id AND confirmed_at IS NULL AND cancelled_at IS NULL
RETURNING *;

-- name: CancelPendingRecoveryRequestsForUser :execrows
-- Cancels every pending request of a user, e.g. before a new request or
-- once 2FA has been turned off another way.
UPDATE recovery_requests
SET cancelled_at = @now::timestamptz
WHERE user_id = @user_id AND confirmed_at IS NULL AND cancelled_at IS NULL;
