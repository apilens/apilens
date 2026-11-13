-- The purge job (#796): removes the data of a deleted project once its grace
-- period has passed. project_purges tracks the progress of each project so a
-- killed run resumes; every query here is idempotent.

-- name: ListPurgeDueProjects :many
-- Projects whose data is due for removal and not purged yet, oldest first:
-- deleted projects past purge_after (or deleted before purge_after existed),
-- and the projects of organizations deleted more than org_grace_seconds ago
-- (an organization delete cannot be undone, so its projects follow it after
-- the same grace as a project delete).
SELECT p.id
FROM projects p
JOIN organizations o ON o.id = p.org_id
WHERE ((p.deleted_at IS NOT NULL AND (p.purge_after IS NULL OR p.purge_after <= now()))
       OR (o.deleted_at IS NOT NULL AND o.deleted_at <= now() - make_interval(secs => @org_grace_seconds::bigint)))
  AND NOT EXISTS (SELECT 1 FROM project_purges pp WHERE pp.project_id = p.id AND pp.step = 'done')
ORDER BY COALESCE(p.purge_after, p.deleted_at, o.deleted_at), p.id
LIMIT @max_projects;

-- name: GetPurgeCandidate :one
-- A project with what the purge needs to decide whether it may run: its
-- deletion state, that of its organization, and the next step of its
-- purge (empty when no purge has started).
SELECT p.id, p.org_id, p.slug, p.name, p.deleted_at, p.purge_after, o.deleted_at AS org_deleted_at,
       COALESCE(pp.step, '')::text AS step
FROM projects p
JOIN organizations o ON o.id = p.org_id
LEFT JOIN project_purges pp ON pp.project_id = p.id
WHERE p.id = @id;

-- name: EndProjectGrace :exec
-- Ends the grace period of a project being purged early (the operator
-- command), so it can no longer be restored half-purged.
UPDATE projects SET purge_after = now()
WHERE id = @id AND purge_after > now();

-- name: StartProjectPurge :one
-- Starts the purge of a project, or resumes it, and returns the next step.
INSERT INTO project_purges (project_id)
VALUES (@project_id)
ON CONFLICT (project_id) DO UPDATE SET attempts = project_purges.attempts + 1, updated_at = now()
RETURNING step;

-- name: SetProjectPurgeStep :exec
-- Records that every step before step is done.
UPDATE project_purges SET step = @step, last_error = NULL, updated_at = now()
WHERE project_id = @project_id AND step <> 'done';

-- name: FailProjectPurge :exec
-- Records why a run stopped; the next run resumes at the same step.
UPDATE project_purges SET last_error = @error, updated_at = now()
WHERE project_id = @project_id;

-- name: LockPurgingProject :one
-- The project being purged, row-locked with its purge for the final step.
SELECT p.id, p.org_id, p.slug, p.name, pp.step
FROM projects p
JOIN project_purges pp ON pp.project_id = p.id
WHERE p.id = @id
FOR UPDATE OF p, pp;

-- name: ListPurgeAppIDs :many
-- Every app of the project, merged and archived ones included.
SELECT id FROM apps WHERE project_id = @project_id;

-- name: ListPurgeKeyIDs :many
-- Every API key of the project, revoked ones included.
SELECT id FROM api_keys WHERE project_id = @project_id;

-- name: ListPurgeExportFiles :many
-- The stored files of the request exports of the project.
SELECT file_key::text AS file_key FROM request_exports WHERE project_id = @project_id AND file_key IS NOT NULL;

-- The Purge* deletes below run in this order in one transaction, children
-- before the rows they reference.

-- name: PurgeProjectAlertEvents :execrows
DELETE FROM alert_events
WHERE rule_id IN (SELECT r.id FROM alert_rules r WHERE r.project_id = @project_id::uuid)
   OR health_check_id IN (SELECT h.id FROM health_checks h WHERE h.project_id = @project_id::uuid)
   OR monitor_app_id IN (SELECT a.id FROM apps a WHERE a.project_id = @project_id::uuid);

-- name: PurgeProjectAlertRules :execrows
-- alert_rule_state goes with its rule (ON DELETE CASCADE).
DELETE FROM alert_rules WHERE project_id = @project_id;

-- name: PurgeProjectNotificationChannels :execrows
DELETE FROM notification_channels WHERE project_id = @project_id;

-- name: PurgeProjectHealthChecks :execrows
DELETE FROM health_checks WHERE project_id = @project_id;

-- name: PurgeProjectUptimeMonitors :execrows
DELETE FROM uptime_monitors WHERE project_id = @project_id;

-- name: PurgeProjectPrivacyPolicies :execrows
DELETE FROM privacy_policies WHERE project_id = @project_id;

-- name: PurgeProjectCapturePolicies :execrows
DELETE FROM capture_policies WHERE app_id IN (SELECT a.id FROM apps a WHERE a.project_id = @project_id::uuid);

-- name: PurgeProjectEndpointSettings :execrows
DELETE FROM endpoint_settings WHERE app_id IN (SELECT a.id FROM apps a WHERE a.project_id = @project_id::uuid);

-- name: PurgeProjectAppMetadata :execrows
DELETE FROM app_metadata WHERE project_id = @project_id;

-- name: PurgeProjectAppInstances :execrows
DELETE FROM app_instances WHERE project_id = @project_id;

-- name: PurgeProjectAppAliases :execrows
DELETE FROM app_aliases WHERE project_id = @project_id;

-- name: PurgeProjectSavedViews :execrows
DELETE FROM saved_views WHERE project_id = @project_id;

-- name: PurgeProjectRequestExports :execrows
DELETE FROM request_exports WHERE project_id = @project_id;

-- name: PurgeProjectMembers :execrows
DELETE FROM project_members WHERE project_id = @project_id;

-- name: PurgeProjectInvitationGrants :execrows
DELETE FROM invitation_project_grants WHERE project_id = @project_id;

-- name: PurgeProjectApps :execrows
-- After every row that references an app; api_key_apps goes with it (ON
-- DELETE CASCADE). apps.merged_into points within the project, so one
-- statement removes both sides.
DELETE FROM apps WHERE project_id = @project_id;

-- name: PurgeProjectAPIKeys :execrows
-- After the apps (apps.created_by_key_id); rotated_from/rotated_to point
-- within the project.
DELETE FROM api_keys WHERE project_id = @project_id;

-- name: PurgeProjectEnvironments :execrows
DELETE FROM environments WHERE project_id = @project_id;

-- name: ReservePurgedProjectSlug :exec
-- Moves the slug of the purged project to the 30-day reservation of renamed
-- slugs (project_slug_history), unless another project already uses it (a
-- project deleted before purge_after existed freed its slug at once).
INSERT INTO project_slug_history (slug, project_id, retired_at)
SELECT @slug::text, @project_id::uuid, now()
WHERE NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.slug = @slug::text AND p.id <> @project_id::uuid AND (p.deleted_at IS NULL OR p.purge_after IS NOT NULL)
)
ON CONFLICT (slug) DO UPDATE SET project_id = EXCLUDED.project_id, retired_at = EXCLUDED.retired_at;

-- name: TombstonePurgedProject :exec
-- Leaves the purged project as a tombstone: deleted, nothing awaiting
-- purge, so projects_slug_reserved no longer holds its slug.
UPDATE projects SET deleted_at = COALESCE(deleted_at, now()), purge_after = NULL
WHERE id = @id;

-- name: FinishProjectPurge :exec
UPDATE project_purges SET step = 'done', last_error = NULL, updated_at = now(), finished_at = now()
WHERE project_id = @project_id;
