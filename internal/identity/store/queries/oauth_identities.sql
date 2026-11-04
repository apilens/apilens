-- name: CreateOAuthIdentity :one
-- Links a provider account to a user. Only identity reads or writes
-- oauth_identities (ADR 0005). provider is 'google' or 'github' (the table
-- check rejects anything else); a (provider, subject) already linked to any
-- user violates the unique constraint. Pass last_login_at when the link is
-- made by a sign-in, NULL when it is made from settings.
INSERT INTO oauth_identities (id, user_id, provider, subject, email, profile, last_login_at)
VALUES (@id, @user_id, @provider, @subject, sqlc.narg('email'), @profile, sqlc.narg('last_login_at'))
RETURNING *;

-- name: GetOAuthIdentityByProviderSubject :one
-- Resolves a provider callback to the linked identity (and so its user).
-- Returns pgx.ErrNoRows when the provider account is not linked.
SELECT * FROM oauth_identities
WHERE provider = @provider AND subject = @subject;

-- name: ListOAuthIdentitiesForUser :many
-- A user's linked providers, oldest link first.
SELECT * FROM oauth_identities
WHERE user_id = @user_id
ORDER BY created_at, id;

-- name: DeleteOAuthIdentity :execrows
-- Unlinks one identity of a user; scoped by user_id so a caller cannot unlink
-- another user's identity. Returns 0 when nothing matched. Check
-- CountOAuthIdentitiesForUser first so a user keeps a way to sign in.
DELETE FROM oauth_identities
WHERE id = @id AND user_id = @user_id;

-- name: CountOAuthIdentitiesForUser :one
-- Number of providers linked to a user.
SELECT count(*) FROM oauth_identities
WHERE user_id = @user_id;
