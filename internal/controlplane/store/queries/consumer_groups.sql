-- name: ListConsumerGroups :many
-- The groups of a project with how many consumers each holds, by name.
SELECT g.id, g.project_id, g.name, g.created_at, g.updated_at,
       (SELECT count(*) FROM consumer_group_members m WHERE m.group_id = g.id)::bigint AS consumers
FROM consumer_groups g
WHERE g.project_id = @project_id
ORDER BY lower(g.name), g.id;

-- name: GetConsumerGroup :one
SELECT g.id, g.project_id, g.name, g.created_at, g.updated_at,
       (SELECT count(*) FROM consumer_group_members m WHERE m.group_id = g.id)::bigint AS consumers
FROM consumer_groups g
WHERE g.id = @id AND g.project_id = @project_id;

-- name: CreateConsumerGroup :one
INSERT INTO consumer_groups (id, project_id, name)
VALUES (@id, @project_id, @name)
RETURNING id, project_id, name, created_at, updated_at;

-- name: RenameConsumerGroup :one
UPDATE consumer_groups
SET name = @name, updated_at = now()
WHERE id = @id AND project_id = @project_id
RETURNING id, project_id, name, created_at, updated_at;

-- name: DeleteConsumerGroup :execrows
DELETE FROM consumer_groups WHERE id = @id AND project_id = @project_id;

-- name: AssignConsumerGroup :one
-- Puts a consumer in a group of the same project, moving it out of the group
-- it was in. No row when the group is not one of the project's.
INSERT INTO consumer_group_members (project_id, consumer_id, group_id)
SELECT g.project_id, @consumer_id::text, g.id
FROM consumer_groups g
WHERE g.id = @group_id AND g.project_id = @project_id
ON CONFLICT (project_id, consumer_id)
    DO UPDATE SET group_id = EXCLUDED.group_id, assigned_at = now()
RETURNING project_id, consumer_id, group_id, assigned_at;

-- name: UnassignConsumerGroup :execrows
DELETE FROM consumer_group_members
WHERE project_id = @project_id AND consumer_id = @consumer_id;

-- name: ListConsumerGroupAssignments :many
-- The groups of the given consumers of a project (consumers without a group
-- are left out).
SELECT m.consumer_id, g.id AS group_id, g.name AS group_name
FROM consumer_group_members m
JOIN consumer_groups g ON g.id = m.group_id
WHERE m.project_id = @project_id AND m.consumer_id = ANY (@consumer_ids::text[]);

-- name: ListConsumerGroupMembers :many
-- The consumer ids in one group of a project.
SELECT consumer_id
FROM consumer_group_members
WHERE project_id = @project_id AND group_id = @group_id
ORDER BY consumer_id;
