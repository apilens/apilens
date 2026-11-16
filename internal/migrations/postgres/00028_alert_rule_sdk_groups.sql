-- Alert rules filter by the SDK consumer group: filters.group is now the
-- group's name as the SDK reports it (consumer_group on each request), not
-- the id of a dashboard consumer group (consumer_groups, 00020).
--
-- A rule whose group filter is the id of one of its project's dashboard
-- groups gets that group's name, so it keeps watching the group of that
-- name. Any other group value (a group deleted since, so the rule counted
-- nobody) is left as is: as an SDK group name it still matches no requests.
-- 00029 then drops the dashboard group tables.

-- +goose Up
UPDATE alert_rules r
SET filters = jsonb_set(r.filters, '{group}', to_jsonb(g.name))
FROM consumer_groups g
WHERE g.project_id = r.project_id
  AND r.filters ? 'group'
  AND jsonb_typeof(r.filters -> 'group') = 'string'
  AND r.filters ->> 'group' = g.id::text;

-- +goose Down
-- Best effort: a group name that is still a dashboard group of the rule's
-- project (ignoring case) goes back to that group's id.
UPDATE alert_rules r
SET filters = jsonb_set(r.filters, '{group}', to_jsonb(g.id::text))
FROM consumer_groups g
WHERE g.project_id = r.project_id
  AND r.filters ? 'group'
  AND jsonb_typeof(r.filters -> 'group') = 'string'
  AND lower(r.filters ->> 'group') = lower(g.name);
