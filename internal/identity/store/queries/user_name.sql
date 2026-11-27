-- name: SetUserNameIfEmpty :execrows
-- Fills a missing name only; a name the user already has is never replaced.
UPDATE users
SET name = @name, updated_at = now()
WHERE id = @id AND (name IS NULL OR btrim(name) = '');
