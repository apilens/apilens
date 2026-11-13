-- Environment display settings and lifecycle (#787, D11 in #753): an
-- environment is hidden rather than deleted once it has data, and carries a
-- production flag, a colour and an order.
--
--   is_production  marks the environments that serve real users; backfilled
--                  true for environments named production or prod.
--   color          one of a fixed palette of eight names (not free hex), so
--                  the UI maps each to a token with a text label; NULL means
--                  no colour.
--   position       the order of the project's environments in settings and
--                  pickers, 0 first; ties (rows written without a position)
--                  fall back to the name. Backfilled production first, then
--                  by name.
--   hidden_at      when the environment was hidden; NULL when visible.
--                  Hidden environments still ingest; pickers leave them out
--                  by default.
--   source         'sdk' when ingest registered it from the data an SDK
--                  sent, 'dashboard' when someone added it (every existing
--                  row was added through the control plane).
--   first_seen_at  when data for the environment was first and last seen;
--   last_seen_at   NULL until it has data. Backfilled from app_instances
--                  (SDK heartbeats); ingest keeps them current (#788).
--
-- An environment can be deleted only when it has no data within retention
-- (last_seen_at) and no active API key is pinned to it and no health check
-- uses it; otherwise the API answers environment_in_use and the caller hides
-- it instead.

-- +goose Up
ALTER TABLE environments
    ADD COLUMN IF NOT EXISTS is_production boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS color         text
        CHECK (color IN ('gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple')),
    ADD COLUMN IF NOT EXISTS position      integer,
    ADD COLUMN IF NOT EXISTS hidden_at     timestamptz,
    ADD COLUMN IF NOT EXISTS source        text NOT NULL DEFAULT 'dashboard'
        CHECK (source IN ('sdk', 'dashboard')),
    ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz;

-- Rows without a position are the ones this migration has not seen yet.
UPDATE environments e
SET is_production = o.prod, position = o.pos
FROM (
    SELECT id,
           name IN ('production', 'prod') AS prod,
           row_number() OVER (PARTITION BY project_id
                              ORDER BY (name IN ('production', 'prod')) DESC, name) - 1 AS pos
    FROM environments
) o
WHERE e.id = o.id AND e.position IS NULL;

ALTER TABLE environments
    ALTER COLUMN position SET DEFAULT 0,
    ALTER COLUMN position SET NOT NULL;

UPDATE environments e
SET first_seen_at = s.first_seen, last_seen_at = s.last_seen
FROM (
    SELECT project_id, environment, min(first_seen_at) AS first_seen, max(last_seen_at) AS last_seen
    FROM app_instances
    GROUP BY project_id, environment
) s
WHERE e.project_id = s.project_id AND e.name = s.environment AND e.last_seen_at IS NULL;

-- +goose Down
ALTER TABLE environments
    DROP COLUMN IF EXISTS last_seen_at,
    DROP COLUMN IF EXISTS first_seen_at,
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS hidden_at,
    DROP COLUMN IF EXISTS position,
    DROP COLUMN IF EXISTS color,
    DROP COLUMN IF EXISTS is_production;
