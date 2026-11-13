-- The project's source repository link (#791), so the Changes pages can
-- turn the release and commit ids the SDKs send into links.
--
--   repository_url  the https URL of the repository's web page, e.g.
--                   https://github.com/acme/shop; NULL when none is set.
--                   The API checks the scheme and the host (github.com,
--                   gitlab.com and bitbucket.org, or any host when
--                   integrations.allow_any_repository_host is on) and
--                   derives the commit and release URL templates from it.
--                   This is a link only: no OAuth, no tokens.

-- +goose Up
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS repository_url text
        CHECK (char_length(repository_url) BETWEEN 1 AND 2048);

-- +goose Down
ALTER TABLE projects DROP COLUMN IF EXISTS repository_url;
