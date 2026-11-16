-- API keys can be pinned to some environments of their project (#774), so a
-- leaked staging key cannot write production data (Honeycomb environment
-- keys).
--
--   environments  the environment names the key may send data for; NULL
--                 means every environment. Names must be environments of the
--                 project when the key is created or changed; the ingest
--                 edge rejects, per record, data for any other environment
--                 (reason environment_not_allowed).
--
-- Names are stored rather than environment ids because records carry the
-- name and the edge checks it from its key cache without a lookup.

-- +goose Up
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS environments text[]
        CHECK (environments IS NULL OR cardinality(environments) BETWEEN 1 AND 50);

-- +goose Down
ALTER TABLE api_keys
    DROP COLUMN IF EXISTS environments;
