-- Consumer groups: named groups a project's API consumers are sorted into.
--
--   projects 1 ── * consumer_groups.project_id
--   consumer_groups 1 ── * consumer_group_members.group_id
--
-- consumer_id is the id the SDK reports for a consumer (api_requests in
-- ClickHouse); there is no consumers table on this side. A consumer belongs
-- to at most one group per project: the primary key makes assigning it to
-- another group move it out of the previous one. Deleting a group leaves its
-- consumers ungrouped. Group names are unique per project, ignoring case.

-- +goose Up
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

-- +goose Down
DROP TABLE IF EXISTS consumer_group_members;
DROP TABLE IF EXISTS consumer_groups;
