-- Purging deleted projects (#796, D8 in #753). Once a deleted project's
-- purge_after has passed, the hourly purge job removes its data everywhere:
-- the ClickHouse telemetry, its Valkey keys and export files, its Postgres
-- rows (apps, environments, keys, policies, alerts, health checks, saved
-- views, exports, grants), its SpiceDB relationships (through the outbox),
-- and moves its slug to the 30-day reservation (project_slug_history).
--
-- One row per project tracks the run, so a purge killed half-way resumes
-- where it stopped; every step is idempotent and may run again.
--
--   project_id   the purged project (projects 1 ── 0..1 project_purges). The
--                projects row itself stays as a tombstone (id, org, slug,
--                name) so audit rows and the slug reservation keep pointing
--                at something; purge_after is cleared, so the slug is no
--                longer held by projects_slug_reserved.
--   step         the next step to run: clickhouse, valkey, files, postgres,
--                then done.
--   attempts     how many runs have worked on it.
--   last_error   the error of the last failed run; NULL once it succeeds.
--   started_at   when the first run began; finished_at when it was done.

-- +goose Up
CREATE TABLE IF NOT EXISTS project_purges (
    project_id  uuid        PRIMARY KEY REFERENCES projects (id),
    step        text        NOT NULL DEFAULT 'clickhouse'
                            CHECK (step IN ('clickhouse', 'valkey', 'files', 'postgres', 'done')),
    attempts    integer     NOT NULL DEFAULT 1,
    last_error  text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

-- +goose Down
DROP TABLE IF EXISTS project_purges;
