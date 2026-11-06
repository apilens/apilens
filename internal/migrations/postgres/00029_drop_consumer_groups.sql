-- Drops the dashboard consumer groups (00020). A consumer's group comes from
-- the SDK (consumer_group on each request) and alert rules filter by that
-- name (00028 copied the names of the groups rules pointed at), so nothing
-- reads these tables any more.

-- +goose Up
DROP TABLE IF EXISTS consumer_group_members;
DROP TABLE IF EXISTS consumer_groups;

-- +goose Down
-- Recreates the tables empty, as 00020 made them.
CREATE TABLE IF NOT EXISTS consumer_groups (
    id          uuid PRIMARY KEY,
    project_id  uuid        NOT NULL REFERENCES projects (id),
    name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS consumer_groups_project_name
    ON consumer_groups (project_id, lower(name));

CREATE TABLE IF NOT EXISTS consumer_group_members (
    project_id   uuid        NOT NULL,
    consumer_id  text        NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 256),
    group_id     uuid        NOT NULL,
    assigned_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, consumer_id),
    FOREIGN KEY (group_id, project_id) REFERENCES consumer_groups (id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS consumer_group_members_group
    ON consumer_group_members (group_id);
