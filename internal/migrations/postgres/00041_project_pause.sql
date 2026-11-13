-- Pausing ingest for a project (#792): while paused_at is set the ingest
-- edge answers 403 project_paused to every ingest call made with one of the
-- project's keys (within the key cache TTL); the dashboard, the query API
-- and the stored data are unaffected. Resuming clears both columns.
--
--   paused_at  when the project was paused; NULL while ingest is accepted.
--   paused_by  who paused it; NULL when not paused or once that user is
--              purged (users 1 ──< projects.paused_by, SET NULL on purge).
--
-- api_keys → projects is already joined on every key lookup, so the edge
-- reads paused_at with the key and needs no index of its own.

-- +goose Up
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS paused_at timestamptz,
    ADD COLUMN IF NOT EXISTS paused_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE projects
    DROP COLUMN IF EXISTS paused_by,
    DROP COLUMN IF EXISTS paused_at;
